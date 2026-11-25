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
  avatarUrl: string | null;
};

export type ProjectItem = {
  id: ProjectItemId;
  kind: MediaKind;
  projectId: ProjectId;
  uploadedBy: UserId;
  comment: string | null;
  labelIds: LabelId[];
  originalId: MediaId;
  compressedId: MediaId | null;
  previewsIds: ProjectItemPreviews | null;
  analysis: ProjectMediaItemAIAnalysis | null;
  createdAt: Date;
};

export type ProjectItemPreviewSizes = "small" | "middle" | "large";

export type ProjectItemPreviews = Partial<Record<ProjectItemPreviewSizes, MediaId>>;

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
  scoreImportance?: number;
  scoreQuality?: number;
  summary: string;
};

export type ProjectMemberRole = "admin" | "contributor" | "viewer";

export type ProjectContributionStatus = "not_started" | "more_coming" | "done";
