import type { MediaId, MontageId, MovieId, ProjectId, UserId } from "./id.ts";

export type Movie = {
  id: MovieId;
  name: string;
  projectId: ProjectId;
  createdBy: UserId;
  createdAt: Date;
  montageId: MontageId;
  originalId: MediaId;
  compressedId: MediaId | null;
  previewId: MediaId | null;
};
