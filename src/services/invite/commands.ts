import { randomInt } from "node:crypto";
import { type Db, sql } from "../../integrations/db/index.ts";
import type { InviteId, ProjectId, UserId } from "../../types/id.ts";
import type { Invite, InviteApp, InviteProject } from "../../types/invite.ts";
import type { ProjectMemberRole } from "../../types/project.ts";
import { grant } from "../consumable/commands.ts";
import { accessOf, canContribute } from "../project/access.ts";
import { inviteRewards } from "../settings/settings.ts";
import { columns, type InviteRow, toInvite } from "./internal.ts";
import { liveAppInvite, liveProjectInvite } from "./queries.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const mintToken = () =>
  Array.from({ length: 6 }, () => ALPHABET.charAt(randomInt(ALPHABET.length))).join("");

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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await insertProjectInvite(sql, input);
    if (row) return { invite: toInvite(row) as InviteProject };
    const raced = await liveProjectInvite(input.projectId);
    if (raced) return { invite: raced };
  }
  throw new Error("could not mint a unique project invite");
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await insertProjectInvite(tx, input);
      if (row) return toInvite(row) as InviteProject;
    }
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
};

export async function createAppInvite(input: NewAppInvite): Promise<InviteApp> {
  const live = await liveAppInvite(input.createdBy);
  if (live) return live;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row] = await sql<InviteRow[]>`
      insert into invites (token, kind, created_by, max_uses, expires_at)
      values (${mintToken()}, 'app', ${input.createdBy}, ${input.maxUses}, ${input.expiresAt})
      on conflict do nothing
      returning ${columns}
    `;
    if (row) return toInvite(row) as InviteApp;
    const raced = await liveAppInvite(input.createdBy);
    if (raced) return raced;
  }
  throw new Error("could not mint a unique app invite");
}

export type InviteDenialReason = "not_found" | "expired" | "exhausted";

export type AcceptResult = { invite: Invite } | { denial: InviteDenialReason };

export async function acceptInvite(token: string, userId: UserId): Promise<AcceptResult> {
  const rewards = await inviteRewards();
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
    const [prior] = await tx`
      select 1 from invite_uses where invite_id = ${invite.id} and user_id = ${userId}
    `;
    if (prior) return { invite };
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
    await tx`
      insert into invite_uses (invite_id, user_id)
      values (${invite.id}, ${userId})
      on conflict do nothing
    `;
    const [used] = await tx<{ id: InviteId }[]>`
      update invites
      set used_count = used_count + 1
      where id = ${invite.id}
      returning id
    `;
    if (!used) return { denial: "exhausted" };
    if (invite.kind === "memory") {
      await tx`
        insert into project_members (project_id, user_id, role, invited_by)
        values (${invite.projectId}, ${userId}, ${invite.role}, ${invite.createdBy})
        on conflict (project_id, user_id) do nothing
      `;
    } else {
      await grant(userId, rewards.invitee);
      await grant(invite.createdBy, rewards.sender);
      await tx`
        insert into contacts (owner_id, contact_id) values
          (${userId}, ${invite.createdBy}),
          (${invite.createdBy}, ${userId})
        on conflict do nothing
      `;
    }
    return { invite };
  });
}
