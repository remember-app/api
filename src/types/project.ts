import type { Consumable } from "./consumables.ts";
import type { LabelId, MediaId, ProjectId, ProjectItemId, UserId } from "./id.ts";
import type { MediaKind } from "./mediaItem.ts";

export type Project = {
  id: ProjectId;
  title: string;
  eventStart: Date;
  eventEnd: Date | null;
  consumables: Consumable;
  itemCount: number;
  memberCount: number;
  sharedCount: number;
  myRole: ProjectMemberRole;
  myContribution: ProjectContributionStatus;
};

export type ProjectMember = {
  userId: UserId;
  username: string | null;
  name: string | null;
  role: ProjectMemberRole;
  consumables: Consumable; // donated and spent(used)
  contribution: ProjectContributionStatus;
  joinedAt: Date;
  invitedBy: UserId | null;
  avatarUrl: string | null;
};

export type ProjectItem = ProjectPhoto | ProjectVideo | ProjectAudio;

export type ProjectPhoto = ProjectItemCommon & {
  derivedMedia: {
    thumbnailId: MediaId | null;
    previewId: MediaId | null;
  };
};

export type ProjectVideo = ProjectItemCommon & {
  derivedMedia: {
    thumbnailId: MediaId | null;
    previewId: MediaId | null;
  };
};

export type ProjectAudio = ProjectItemCommon & {
  derivedMedia: {
    thumbnailId: MediaId | null;
  };
};

export type ProjectItemCommon = {
  id: ProjectItemId;
  kind: MediaKind;
  mediaId: MediaId;
  projectId: ProjectId;
  description: string | null;
  labelIds: LabelId[];
  analysis: ProjectMediaItemAIAnalysis | null;
  createdAt: Date;
};

export type AnalysisLevel = "low" | "medium" | "high";

export type AnalysisTags = Record<string, string>;

export type AnalysisSegment = {
  secStart: number;
  secEnd: number;
  description: string;
  tags: AnalysisTags | null;
};

export type ProjectMediaItemAIAnalysis =
  | ProjectMediaItemAIAnalysisPhoto
  | ProjectMediaItemAIAnalysisVideo
  | ProjectMediaItemAIAnalysisAudio;

export type ProjectMediaItemAIAnalysisVideo = ProjectMediaItemAIAnalysisCommon & {
  description: string;
  tags: AnalysisTags | null;
  frames: AnalysisSegment[] | null;
  sounds: AnalysisSegment[] | null;
  words: AnalysisSegment[] | null;
};

export type ProjectMediaItemAIAnalysisAudio = ProjectMediaItemAIAnalysisCommon & {
  description: string;
  tags: AnalysisTags | null;
  sounds: AnalysisSegment[] | null;
  words: AnalysisSegment[] | null;
};

export type ProjectMediaItemAIAnalysisPhoto = ProjectMediaItemAIAnalysisCommon & {
  description: string;
  tags: AnalysisTags | null;
};

export type ProjectMediaItemAIAnalysisCommon = {
  level: AnalysisLevel;
  score: number;
  summary: string;
};

export type ProjectMemberRole = "admin" | "contributor" | "viewer";

export type ProjectContributionStatus = "not_started" | "more_coming" | "done";
