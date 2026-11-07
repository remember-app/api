import { randomBytes } from "node:crypto";
import { type Db, sql } from "../../integrations/db/index.ts";
import type { InviteId, ProjectId, UserId } from "../../types/id.ts";
import type { Invite, InviteApp, InviteProject } from "../../types/invite.ts";
import type { ProjectMemberRole } from "../../types/project.ts";
import { grant } from "../consumable/commands.ts";
import { accessOf, canContribute } from "../project/access.ts";
import { columns, type InviteRow, toInvite } from "./internal.ts";
import { liveProjectInvite } from "./queries.ts";

const mintToken = () => randomBytes(32).toString("base64url");

export type InviteDenial = { denial: "not_found" | "forbidden" };

export type NewProjectInvite = {
  projectId: ProjectId;
  role: ProjectMemberRole;
  createdBy: UserId;
  maxUses: number | null;
  expiresAt: Date | null;
};

async function insertProjectInvite(
  db: Db,
  input: NewProjectInvite,
): Promise<InviteRow | undefined> {
  const [row] = await db<InviteRow[]>`
    insert into invites (token, kind, created_by, max_uses, expires_at, project_id, role)
    values (
      ${mintToken()},
      'memory',
      ${input.createdBy},
      ${input.maxUses},
      ${input.expiresAt},
      ${input.projectId},
      ${input.role}
    )
    on conflict do nothing
    returning ${columns}
  `;
  return row;
}

async function mayInvite(
  projectId: ProjectId,
  viewerId: UserId,
): Promise<{ ok: true } | InviteDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (!canContribute(access)) return { denial: "forbidden" };
  return { ok: true };
}

export async function createProjectInvite(
  input: NewProjectInvite,
): Promise<{ invite: InviteProject } | InviteDenial> {
  const allowed = await mayInvite(input.projectId, input.createdBy);
  if ("denial" in allowed) return allowed;
  const live = await liveProjectInvite(input.projectId);
  if (live) return { invite: live };
  const row = await insertProjectInvite(sql, input);
  if (!row) {
    const raced = await liveProjectInvite(input.projectId);
    if (!raced) throw new Error("project invite insert lost a race and no live invite is left");
    return { invite: raced };
  }
  return { invite: toInvite(row) as InviteProject };
}

export async function rotateProjectInvite(
  input: NewProjectInvite,
): Promise<{ invite: InviteProject } | InviteDenial> {
  const allowed = await mayInvite(input.projectId, input.createdBy);
  if ("denial" in allowed) return allowed;
  const invite = await sql.begin(async (tx) => {
    await tx`
      update invites
      set revoked_at = now()
      where project_id = ${input.projectId} and kind = 'memory' and revoked_at is null
    `;
    const row = await insertProjectInvite(tx, input);
    if (row) return toInvite(row) as InviteProject;
    const [live] = await tx<InviteRow[]>`
      select ${columns}
      from invites
      where project_id = ${input.projectId} and kind = 'memory' and revoked_at is null
    `;
    if (!live) throw new Error("project invite rotation left no live invite");
    return toInvite(live) as InviteProject;
  });
  return { invite };
}

export type NewAppInvite = {
  createdBy: UserId;
  maxUses: number | null;
  expiresAt: Date | null;
  senderReward: { tokens: number; storageBytes: number };
  inviteeReward: { tokens: number; storageBytes: number };
};

export async function createAppInvite(input: NewAppInvite): Promise<InviteApp> {
  const [row] = await sql<InviteRow[]>`
    insert into invites (
      token,
      kind,
      created_by,
      max_uses,
      expires_at,
      sender_reward_tokens,
      sender_reward_storage_bytes,
      invitee_reward_tokens,
      invitee_reward_storage_bytes
    )
    values (
      ${mintToken()},
      'app',
      ${input.createdBy},
      ${input.maxUses},
      ${input.expiresAt},
      ${input.senderReward.tokens},
      ${input.senderReward.storageBytes},
      ${input.inviteeReward.tokens},
      ${input.inviteeReward.storageBytes}
    )
    returning ${columns}
  `;
  if (!row) throw new Error("app invite insert returned no row");
  return toInvite(row) as InviteApp;
}

export type InviteDenialReason = "not_found" | "expired" | "exhausted";

export type AcceptResult = { invite: Invite } | { denial: InviteDenialReason };

export async function acceptInvite(token: string, userId: UserId): Promise<AcceptResult> {
  return sql.begin(async (tx) => {
    const [row] = await tx<InviteRow[]>`
      select ${columns} from invites where token = ${token} for update
    `;
    if (!row) return { denial: "not_found" };
    const invite = toInvite(row);
    if (invite.revokedAt !== null) return { denial: "not_found" };
    if (invite.expiresAt !== null && invite.expiresAt <= new Date()) {
      return { denial: "expired" };
    }
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      return { denial: "exhausted" };
    }
    if (invite.kind === "app" && invite.createdBy === userId) {
      return { denial: "not_found" };
    }
    if (invite.kind === "memory") {
      const [already] = await tx`
        select 1 from project_members where project_id = ${invite.projectId} and user_id = ${userId}
      `;
      if (already) return { invite };
    }
    const [used] = await tx<{ id: InviteId }[]>`
      update invites
      set used_count = used_count + 1
      where id = ${invite.id}
      returning id
    `;
    if (!used) return { denial: "exhausted" };
    await tx`
      insert into invite_uses (invite_id, user_id)
      values (${invite.id}, ${userId})
      on conflict do nothing
    `;
    if (invite.kind === "memory") {
      await tx`
        insert into project_members (project_id, user_id, role, invited_by)
        values (${invite.projectId}, ${userId}, ${invite.role}, ${invite.createdBy})
        on conflict (project_id, user_id) do nothing
      `;
    } else {
      await grant(userId, invite.inviteeReward);
      await grant(invite.createdBy, invite.senderReward);
    }
    return { invite };
  });
}
