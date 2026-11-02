import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { findByUsername, type PublicUser } from "../auth/identity.ts";
import { sql } from "../db.ts";
import { dropKeys, removeMedia } from "../media/gallery.ts";
import { handOverLabels } from "../media/labels.ts";
import { type ContributionStatus, cards, type MemberRole, seenBy, uuidPattern } from "./plugin.ts";
import { notifyInvited } from "./push.ts";

type InviteRole = "contributor" | "viewer";
const inviteRole = { type: "string", enum: ["contributor", "viewer"] } as const;
const defaultRole: InviteRole = "contributor";
const inviteByUsernameBody = {
  type: "object",
  required: ["username", "role"],
  additionalProperties: false,
  properties: { username: { type: "string" }, role: inviteRole },
} as const;
const rotateBody = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: { role: inviteRole },
} as const;
const acceptBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: { token: { type: "string", minLength: 1, maxLength: 200 } },
} as const;
const contributionStatusBody = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: { status: { type: "string", enum: ["more_coming", "done", "nothing"] } },
} as const;
type Invite = {
  token: string;
  role: InviteRole;
};
const mintToken = () => randomBytes(32).toString("base64url");
async function activeInvite(memoryId: string, role: InviteRole, createdBy: string) {
  const live = await sql<Invite[]>`
    select token, role from invites where memory_id = ${memoryId} and revoked_at is null
  `;
  if (live[0]) return live[0];
  const minted = await sql<Invite[]>`
    insert into invites (memory_id, token, role, created_by)
    values (${memoryId}, ${mintToken()}, ${role}, ${createdBy})
    on conflict do nothing
    returning token, role
  `;
  if (minted[0]) return minted[0];
  const raced = await sql<Invite[]>`
    select token, role from invites where memory_id = ${memoryId} and revoked_at is null
  `;
  if (!raced[0]) throw new Error("invite mint lost a race with a revoke");
  return raced[0];
}
export function memberRoutes(app: FastifyInstance) {
  const mayInvite = (role: MemberRole) => role !== "viewer";
  const forbidden = { error: "forbidden" };
  const notFound = { error: "not found" };
  app.post<{
    Params: {
      memoryId: string;
    };
    Body: {
      username: string;
      role: InviteRole;
    };
  }>(
    "/memories/:memoryId/members",
    {
      preHandler: [app.authenticate, app.requireMembership],
      schema: { body: inviteByUsernameBody },
    },
    async (request, reply) => {
      const { memory, role: callerRole } = request.membership;
      if (!mayInvite(callerRole)) return reply.code(403).send(forbidden);
      const invitee = await findByUsername(request.body.username);
      if (!invitee) return reply.code(404).send(notFound);
      const [added] = await sql<
        {
          role: MemberRole;
        }[]
      >`
        insert into memory_members (memory_id, user_id, role, invited_by)
        values (${memory.id}, ${invitee.id}, ${request.body.role}, ${request.user.id})
        on conflict (memory_id, user_id) do nothing
        returning role
      `;
      if (!added) {
        const [existing] = await sql<
          {
            role: MemberRole;
          }[]
        >`
          select role from memory_members
          where memory_id = ${memory.id} and user_id = ${invitee.id}
        `;
        return { ...invitee, role: existing?.role };
      }
      await notifyInvited(
        request.log,
        invitee.id,
        request.user.name ?? request.user.username,
        memory,
      );
      return { ...invitee, role: added.role };
    },
  );
  app.get<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId/members",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request) => {
      const { memory, role } = request.membership;
      type Row = PublicUser & {
        role: MemberRole;
        contribution_status: ContributionStatus | null;
        media_count: number;
        removal_media_count: number | null;
      };
      return sql<Row[]>`
        select u.id, u.username, u.name, mm.role,
          case when mm.role = 'viewer' then null else mm.status end as contribution_status,
          brought.seen as media_count,
          case when ${role === "organizer"} or mm.user_id = ${request.user.id}
            then brought.whole end as removal_media_count
        from memory_members mm
        join users u on u.id = mm.user_id
        join lateral (
          select count(*) filter (where ${seenBy("mi", request.user.id)})::int as seen,
            count(*)::int as whole
          from media_items mi
          where mi.memory_id = mm.memory_id and mi.uploaded_by = mm.user_id
            and mi.status <> 'pending_upload'
        ) brought on true
        where mm.memory_id = ${memory.id}
        order by mm.created_at, u.id
      `;
    },
  );
  app.post<{
    Params: {
      memoryId: string;
    };
    Body: {
      status: Exclude<ContributionStatus, "not_started">;
    };
  }>(
    "/memories/:memoryId/contribution-status",
    {
      preHandler: [app.authenticate, app.requireMembership],
      schema: { body: contributionStatusBody },
    },
    async (request, reply) => {
      if (request.membership.role === "viewer") return reply.code(403).send(forbidden);
      const { status } = request.body;
      await sql`
        update memory_members set status = ${status}
        where memory_id = ${request.membership.memory.id} and user_id = ${request.user.id}
      `;
      return { status };
    },
  );
  app.get<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId/invite",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (!mayInvite(role)) return reply.code(403).send(forbidden);
      return activeInvite(memory.id, defaultRole, request.user.id);
    },
  );
  app.post<{
    Params: {
      memoryId: string;
    };
    Body: {
      role?: InviteRole;
    };
  }>(
    "/memories/:memoryId/invite",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: rotateBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (!mayInvite(role)) return reply.code(403).send(forbidden);
      return sql.begin(async (tx) => {
        await tx`
          update invites set revoked_at = now()
          where memory_id = ${memory.id} and revoked_at is null
        `;
        const [minted] = await tx<Invite[]>`
          insert into invites (memory_id, token, role, created_by)
          values (${memory.id}, ${mintToken()}, ${request.body?.role ?? defaultRole},
                  ${request.user.id})
          returning token, role
        `;
        if (!minted) throw new Error("insert into invites returned no row");
        return minted;
      });
    },
  );
  app.post<{
    Body: {
      token: string;
    };
  }>(
    "/invites/accept",
    { preHandler: app.authenticate, schema: { body: acceptBody } },
    async (request, reply) => {
      const [invite] = await sql<
        {
          memory_id: string;
          role: InviteRole;
          created_by: string;
        }[]
      >`
        select memory_id, role, created_by from invites
        where token = ${request.body.token} and revoked_at is null
      `;
      if (!invite) return reply.code(404).send(notFound);
      await sql`
        insert into memory_members (memory_id, user_id, role, invited_by)
        values (${invite.memory_id}, ${request.user.id}, ${invite.role}, ${invite.created_by})
        on conflict (memory_id, user_id) do nothing
      `;
      const [card] = await cards(request.user.id, invite.memory_id);
      return card ?? reply.code(404).send(notFound);
    },
  );
  app.delete<{
    Params: {
      memoryId: string;
      userId: string;
    };
  }>(
    "/memories/:memoryId/members/:userId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const { userId } = request.params;
      const self = userId === request.user.id;
      if (!self && role !== "organizer") return reply.code(403).send(forbidden);
      if (self && role === "organizer") {
        return reply.code(409).send({ error: "organizer cannot leave the memory" });
      }
      if (!uuidPattern.test(userId)) return reply.code(404).send(notFound);
      const left = await sql.begin(async (tx) => {
        const removed = await tx`
          delete from memory_members
          where memory_id = ${memory.id} and user_id = ${userId}
          returning user_id
        `;
        if (removed.length === 0) return null;
        await handOverLabels(tx, memory.id, userId, memory.organizer_id);
        return removeMedia(tx, memory.id, { uploadedBy: userId });
      });
      if (left === null) return reply.code(404).send(notFound);
      await dropKeys(request.log, left);
      return { ok: true };
    },
  );
}
