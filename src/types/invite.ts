import type { InviteId, ProjectId, UserId } from "./id.ts";
import type { ProjectMemberRole } from "./project.ts";

export type Invite = InviteProject | InviteApp;

export type InviteProject = InviteBase & {
  kind: "memory";
  projectId: ProjectId;
  role: ProjectMemberRole;
};

export type InviteApp = InviteBase & {
  kind: "app";
  senderReward: InviteReward;
  inviteeReward: InviteReward;
};

export type InviteUse = {
  inviteId: InviteId;
  userId: UserId;
  usedAt: Date;
};

export type InviteReward = {
  tokens: number;
  storageBytes: number;
};

export type InviteBase = {
  id: InviteId;
  token: string;
  createdBy: UserId;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  maxUses: number | null;
  usedCount: number;
};
