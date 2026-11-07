import type { PageResponse } from "./common.ts";
import type { ConsumableResponse } from "./user.ts";

export type Role = "admin" | "contributor" | "viewer";

export type ContributionStatus = "not_started" | "more_coming" | "done";

export type ProjectResponse = {
  id: string;
  title: string;
  eventStart: string;
  eventEnd: string | null;
  consumables: ConsumableResponse;
  itemCount: number;
  memberCount: number;
  sharedCount: number;
  myRole: Role;
  myContribution: ContributionStatus;
};

export type ProjectCardResponse = ProjectResponse & {
  previewUrls: string[];
};

export type ProjectsPageResponse = PageResponse<ProjectCardResponse>;

export type MemberResponse = {
  userId: string;
  username: string | null;
  name: string | null;
  role: Role;
  consumables: ConsumableResponse;
  contribution: ContributionStatus;
  joinedAt: string;
  invitedBy: string | null;
};

export type MembersPageResponse = PageResponse<MemberResponse>;

export type CreateProjectRequest = {
  title: string;
  eventStart: string;
  eventEnd?: string | null;
  storageBytes?: number;
};

export type UpdateProjectRequest = {
  title?: string;
  eventStart?: string;
  eventEnd?: string | null;
};

export type AddMemberRequest = {
  username: string;
  role: Role;
};

export type ContributionRequest = {
  status: ContributionStatus;
};

export type ContributionResponse = {
  status: ContributionStatus;
};

export type DonateConsumablesRequest = {
  tokens?: number;
  storageBytes?: number;
};

export type DonateConsumablesResponse = {
  project: ConsumableResponse;
  member: ConsumableResponse;
};

export type ProjectInviteRequest = {
  role?: Role;
  maxUses?: number | null;
};

export type ProjectInviteResponse = {
  token: string;
  role: Role;
};

export type AppInviteReward = {
  tokens?: number;
  storageBytes?: number;
};

export type AppInviteRequest = {
  maxUses?: number | null;
  expiresAt?: string | null;
  senderReward?: AppInviteReward;
  inviteeReward?: AppInviteReward;
};

export type AppInviteResponse = {
  token: string;
  maxUses: number | null;
};

export type AcceptInviteRequest = {
  token: string;
};

export type JoinResponse = ProjectResponse | { joined: true };
