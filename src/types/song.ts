import type { MediaId, ProjectId, SongId, UserId } from "./id.ts";
import type { ProjectMediaItemAIAnalysisAudio } from "./project.ts";

export type Song = {
  id: SongId;
  name: string;
  author: string;
  mediaId: MediaId;
  coverId: MediaId | null;
  description: string | null;
  projectId: ProjectId | null;
  uploadedBy: UserId | null;
  analysis: ProjectMediaItemAIAnalysisAudio | null;
};
