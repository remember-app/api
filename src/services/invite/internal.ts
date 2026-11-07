import { sql } from "../../integrations/db/index.ts";
import type { InviteId, ProjectId, UserId } from "../../types/id.ts";
import type { Invite } from "../../types/invite.ts";
import type { ProjectMemberRole } from "../../types/project.ts";

export const columns = sql`
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
  sender_reward_tokens::float8 as "senderRewardTokens",
  sender_reward_storage_bytes::float8 as "senderRewardStorageBytes",
  invitee_reward_tokens::float8 as "inviteeRewardTokens",
  invitee_reward_storage_bytes::float8 as "inviteeRewardStorageBytes"
`;

export type InviteRow = {
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

export const toInvite = (row: InviteRow): Invite => {
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
