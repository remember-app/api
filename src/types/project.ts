import type { Consumable } from "./consumables.ts";
import type { LabelId, MediaId, ProjectId, ProjectItemId, UserId } from "./id.ts";
import type { MediaKind } from "./mediaItem.ts";

export type ProjectMember = {
  userId: UserId;
  username: string | null;
  name: string | null;
  role: ProjectMemberRole;
  consumables: Consumable; // donated and spent(used)
  contribution: ProjectContributionStatus;
  joinedAt: Date;
  invitedBy: UserId | null;
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

export type ProjectMediaItemAIAnalysis =
  | ProjectMediaItemAIAnalysisPhoto
  | ProjectMediaItemAIAnalysisVideo
  | ProjectMediaItemAIAnalysisAudio;

export type ProjectMediaItemAIAnalysisAudio = ProjectMediaItemAIAnalysisCommon & {
  transcription: { secStart: number; secEnd: number; text: string }[];
  mood: { secStart: number; secEnd: number; text: string }[] | null;
};

export type ProjectMediaItemAIAnalysisVideo = ProjectMediaItemAIAnalysisCommon & {
  frames: { second: number; text: string }[];
  transcription: { secStart: number; secEnd: number; text: string }[] | null;
};

export type ProjectMediaItemAIAnalysisPhoto = ProjectMediaItemAIAnalysisCommon & {};

export type ProjectMediaItemAIAnalysisCommon = {
  description: string;
  score: number;
};

export type ProjectMemberRole = "admin" | "contributor" | "viewer";

export type ProjectContributionStatus = "not_started" | "more_coming" | "done";
