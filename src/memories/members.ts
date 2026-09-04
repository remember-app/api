import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { findByUsername, type PublicUser } from "../auth/identity.ts";
import { sql } from "../db.ts";
import { dropKeys, removeMedia } from "../media/gallery.ts";
import { type MemberRole, type Memory, uuidPattern } from "./plugin.ts";
import { notifyInvited } from "./push.ts";

/**
 * What may be handed out. Never `organizer`: a memory has exactly one, its
 * creator, and handing that role to a second person would hand out the right
 * to exclude the first. The database holds the same rule as a CHECK.
 */
type InviteRole = "contributor" | "viewer";
const inviteRole = { type: "string", enum: ["contributor", "viewer"] } as const;

/** The default a link grants: people are invited to *bring* material (doc-01). */
const defaultRole: InviteRole = "contributor";

const inviteByUsernameBody = {
  type: "object",
  required: ["username", "role"],
  additionalProperties: false,
  // Deliberately unconstrained beyond «a string»: what may be *asked for* is
  // settled by the rule that governs what may be *held* (`findByUsername`), so
  // a name nobody could ever register answers 404 rather than 400.
  properties: { username: { type: "string" }, role: inviteRole },
} as const;

/**
 * `null` as well as an object: everything here is optional, so «просто дай
 * новую ссылку» is a POST with no body at all, and Fastify hands a missing
 * body to the schema as null — which a bare `type: "object"` refuses with a
 * 400 that would read as «rotation is broken».
 */
const rotateBody = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: { role: inviteRole },
} as const;

const acceptBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  // Bounded so that an unknown token is a cheap index probe and not a long
  // string carried into the database.
  properties: { token: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

type Invite = { token: string; role: InviteRole };

/** Opaque and unguessable, like a session token: 32 bytes out of `node:crypto`. */
const mintToken = () => randomBytes(32).toString("base64url");

/**
 * The one live link of a memory, minted on first ask. `invites_one_active_idx`
 * — one live row per memory — is what makes «the link» a single thing, so the
 * race it guards is handled here rather than answered with a 500: two devices
 * asking at once must both come away with the same link.
 */
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

  // The insert hit the partial index, so somebody else minted between our two
  // statements — their link is the answer.
  const raced = await sql<Invite[]>`
    select token, role from invites where memory_id = ${memoryId} and revoked_at is null
  `;
  if (!raced[0]) throw new Error("invite mint lost a race with a revoke");
  return raced[0];
}

/**
 * The memory as its member sees it — the body `POST /memories` answers with,
 * so that accepting an invite lands the client on the same shape it already
 * knows how to open.
 */
const memoryFor = async (memoryId: string, userId: string) => {
  const [row] = await sql<(Memory & { role: MemberRole })[]>`
    select m.*, mm.role
    from memory_members mm
    join memories m on m.id = mm.memory_id
    where mm.memory_id = ${memoryId} and mm.user_id = ${userId}
  `;
  return row;
};

/**
 * Getting into a memory and out of one: by username, by link, and removal.
 * Called from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check these routes mount.
 */
export function memberRoutes(app: FastifyInstance) {
  // Inviting is `contributor` and up — the matrix in architecture.md gives
  // «звать людей» to contributors, and a viewer may only look.
  const mayInvite = (role: MemberRole) => role !== "viewer";
  const forbidden = { error: "forbidden" };
  const notFound = { error: "not found" };

  app.post<{ Params: { memoryId: string }; Body: { username: string; role: InviteRole } }>(
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

      const [added] = await sql<{ role: MemberRole }[]>`
        insert into memory_members (memory_id, user_id, role, invited_by)
        values (${memory.id}, ${invitee.id}, ${request.body.role}, ${request.user.id})
        on conflict (memory_id, user_id) do nothing
        returning role
      `;

      // Already in — including the organizer, whose role must survive being
      // «invited» — so nothing changed and nobody is told anything. Their
      // standing role is what comes back, not the one that was asked for.
      if (!added) {
        const [existing] = await sql<{ role: MemberRole }[]>`
          select role from memory_members
          where memory_id = ${memory.id} and user_id = ${invitee.id}
        `;
        return { ...invitee, role: existing?.role };
      }

      // Committed above, on its own, and only then this — a push that fails
      // must not undo an invite that worked. `notifyInvited` swallows
      // everything for that reason; see the ceiling noted on it.
      await notifyInvited(
        request.log,
        invitee.id,
        request.user.name ?? request.user.username ?? "Кто-то",
        memory,
      );
      return { ...invitee, role: added.role };
    },
  );

  // Who is in this memory. Every member may read it, `viewer` included: the
  // matrix gives them «смотреть», and seeing who else was at the event is that
  // — not a power over the memory. No `mayInvite` gate here on purpose.
  app.get<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/members",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request) => {
      // The same three fields `GET /users` hands out and no more — one user
      // shape for the client, and deliberately no email: whoever followed an
      // invite link can read this, so a roster must not turn into an address
      // book. `invited_by` is left out for the same reason it is not on the
      // invite response: it is a uuid the client has nothing to do with.
      return sql<(PublicUser & { role: MemberRole })[]>`
        select u.id, u.username, u.name, mm.role
        from memory_members mm
        join users u on u.id = mm.user_id
        where mm.memory_id = ${request.membership.memory.id}
        order by mm.created_at, u.id
      `;
    },
  );

  // The link as it stands. Minting on read rather than behind a separate
  // «create» call: the client asks this the moment somebody taps «поделиться»,
  // and there is nothing it could usefully do with «no link yet».
  app.get<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/invite",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (!mayInvite(role)) return reply.code(403).send(forbidden);
      return activeInvite(memory.id, defaultRole, request.user.id);
    },
  );

  // Rotation, which is the only revoke there is: a memory always has a link,
  // so «отозвать» means the old token stops working and a new one takes its
  // place. This is also how the level a link grants is changed.
  app.post<{ Params: { memoryId: string }; Body: { role?: InviteRole } }>(
    "/memories/:memoryId/invite",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: rotateBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (!mayInvite(role)) return reply.code(403).send(forbidden);

      // One transaction, because between the two statements the memory has no
      // live link: a reader arriving in that gap would mint a third one, and
      // this insert would then break on the partial index and roll back —
      // leaving the old link alive, which is the safe way to lose this race.
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

  // Behind the session check only — the caller is not a member yet, which is
  // the whole point. There is no web page and no anonymous path: the link is a
  // deep link into the app and whoever follows it already has an account
  // (decision-01).
  app.post<{ Body: { token: string } }>(
    "/invites/accept",
    { preHandler: app.authenticate, schema: { body: acceptBody } },
    async (request, reply) => {
      const [invite] = await sql<{ memory_id: string; role: InviteRole; created_by: string }[]>`
        select memory_id, role, created_by from invites
        where token = ${request.body.token} and revoked_at is null
      `;
      // Revoked and never-existed are one answer: a rotated token must tell
      // whoever kept it nothing about the memory it used to open.
      if (!invite) return reply.code(404).send(notFound);

      // Already a member — of any standing, the organizer included — keeps the
      // role they have. A link is a way in, not a way to change level.
      await sql`
        insert into memory_members (memory_id, user_id, role, invited_by)
        values (${invite.memory_id}, ${request.user.id}, ${invite.role}, ${invite.created_by})
        on conflict (memory_id, user_id) do nothing
      `;
      // No push: this person acted themselves, they know where they are.
      return memoryFor(invite.memory_id, request.user.id);
    },
  );

  // Removal and leaving are the same act on the same row, and which one it is
  // depends only on whether the target is the caller.
  app.delete<{ Params: { memoryId: string; userId: string } }>(
    "/memories/:memoryId/members/:userId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const { userId } = request.params;
      const self = userId === request.user.id;

      // Anyone may walk out; only the organizer may show somebody else out.
      if (!self && role !== "organizer") return reply.code(403).send(forbidden);
      // The organizer cannot: their leaving would leave the memory with nobody
      // able to exclude, delete or order a montage, and handing the role over
      // is out of MVP (doc-01: «Передача роли организатора — вне MVP»).
      if (self && role === "organizer") {
        return reply.code(409).send({ error: "organizer cannot leave the memory" });
      }
      // Not a member, and «not a uuid» is not a member either — that check is
      // here and not in a params schema on purpose: schema validation runs
      // *before* the preHandlers, so it would answer 400 where the house rule
      // for this route family is 404.
      if (!uuidPattern.test(userId)) return reply.code(404).send(notFound);

      // Everything this person brought to this memory goes out with them: the
      // records, the counters, their queued previews and — after the commit —
      // the originals and derivatives in R2 (architecture.md, «Выход /
      // исключение участника»). Montages already cut are left alone, even
      // where their frames are in them (m-2).
      //
      // One transaction, because a departure that took the material but left
      // the person — or the reverse — is worse than either half. The membership
      // row goes first so that «нет такого участника» costs one statement and
      // touches nothing else.
      const keys = await sql.begin(async (tx) => {
        const removed = await tx`
          delete from memory_members
          where memory_id = ${memory.id} and user_id = ${userId}
          returning user_id
        `;
        if (removed.length === 0) return null;
        return removeMedia(tx, memory.id, { uploadedBy: userId });
      });
      if (keys === null) return reply.code(404).send(notFound);

      // Outside the transaction, and best effort — see `dropKeys`.
      await dropKeys(request.log, keys);
      return { ok: true };
    },
  );
}
