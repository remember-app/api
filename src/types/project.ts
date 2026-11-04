import type { LabelId, MediaId, MovieId, ProjectId, ProjectItemId, UserId } from "./id.ts";
import type { MediaKind } from "./mediaItem.ts";

export type Project = {
  id: ProjectId;
  title: string;
  eventStart: Date;
  eventEnd: Date | null;
  createdAt: Date;
  members: ProjectMember[];
  coverItemId: ProjectItemId | null;
  itemIds: ProjectItemId[];
  musicIds: MediaId[];
  movieIds: MovieId[];
};

export type ProjectMember = {
  userId: UserId;
  role: ProjectMemberRole;
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
};

export type ProjectMediaItemAIAnalysis = {
  description: string;
  speech: string | null;
  tags: string[];
  score: number;
};

export type ProjectMemberRole = "admin" | "contributor" | "viewer";

export type ProjectContributionStatus = "not_started" | "more_coming" | "done" | "nothing";
