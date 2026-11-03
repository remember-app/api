import type { MediaId, MontageId, MovieId, ProjectId, UserId } from "./id.ts";

export type Movie = {
  id: MovieId;
  name: string;
  projectId: ProjectId;
  createdBy: UserId;
  createdAt: Date;
  montageId: MontageId;
  videoId: MediaId;
  derived: {
    thumbnailId: MediaId | null;
    previewId: MediaId | null;
  };
};
