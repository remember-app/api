import { randomBytes } from "node:crypto";
import { type Db, sql } from "../../integrations/db/index.ts";
import type { InviteId, ProjectId, UserId } from "../../types/id.ts";
import type { Invite, InviteApp, InviteProject } from "../../types/invite.ts";
import type { ProjectMemberRole } from "../../types/project.ts";
import { grant } from "../limit/limit.ts";

const columns = sql`
  id,
  token,
  kind,
  created_by as "createdBy",
  created_at as "createdAt",
  expires_at as "expiresAt",
  revoked_at as "revokedAt",
  max_uses as "maxUses",
  used_count as "usedCount",
  project_id as "projectId",
  role,
  sender_reward_tokens as "senderRewardTokens",
  sender_reward_storage_bytes as "senderRewardStorageBytes",
  invitee_reward_tokens as "inviteeRewardTokens",
  invitee_reward_storage_bytes as "inviteeRewardStorageBytes"
`;

type InviteRow = {
  id: InviteId;
  token: string;
  kind: "memory" | "app";
  createdBy: UserId;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  maxUses: number | null;
  usedCount: number;
  projectId: ProjectId | null;
  role: ProjectMemberRole | null;
  senderRewardTokens: number | null;
  senderRewardStorageBytes: number | null;
  inviteeRewardTokens: number | null;
  inviteeRewardStorageBytes: number | null;
};

const toInvite = (row: InviteRow): Invite => {
  const base = {
    id: row.id,
    token: row.token,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
  };
  if (row.kind === "memory") {
    if (!row.projectId || !row.role) {
      throw new Error(`project invite ${row.id} has no project or role`);
    }
    return { ...base, kind: "memory", projectId: row.projectId, role: row.role };
  }
  return {
    ...base,
    kind: "app",
    senderReward: {
      tokens: row.senderRewardTokens ?? 0,
      storageBytes: row.senderRewardStorageBytes ?? 0,
    },
    inviteeReward: {
      tokens: row.inviteeRewardTokens ?? 0,
      storageBytes: row.inviteeRewardStorageBytes ?? 0,
    },
  };
};

const mintToken = () => randomBytes(32).toString("base64url");

export async function getInviteByToken(token: string): Promise<Invite | undefined> {
  const [row] = await sql<InviteRow[]>`select ${columns} from invites where token = ${token}`;
  return row && toInvite(row);
}

export async function liveProjectInvite(projectId: ProjectId): Promise<InviteProject | undefined> {
  const [row] = await sql<InviteRow[]>`
    select ${columns}
    from invites
    where project_id = ${projectId} and kind = 'memory' and revoked_at is null
  `;
  return row && (toInvite(row) as InviteProject);
}

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

export async function createProjectInvite(input: NewProjectInvite): Promise<InviteProject> {
  const live = await liveProjectInvite(input.projectId);
  if (live) return live;
  const row = await insertProjectInvite(sql, input);
  if (!row) {
    const raced = await liveProjectInvite(input.projectId);
    if (!raced) throw new Error("project invite insert lost a race and no live invite is left");
    return raced;
  }
  return toInvite(row) as InviteProject;
}

export async function rotateProjectInvite(input: NewProjectInvite): Promise<InviteProject> {
  return sql.begin(async (tx) => {
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

export async function revokeInvite(id: InviteId): Promise<boolean> {
  const rows = await sql`
    update invites set revoked_at = now() where id = ${id} and revoked_at is null returning id
  `;
  return rows.length > 0;
}

export type InviteDenial = "not_found" | "expired" | "exhausted";

export type AcceptResult = { invite: Invite } | { denial: InviteDenial };

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
