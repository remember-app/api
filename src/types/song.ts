import type { MediaId, ProjectId, SongId, UserId } from "./id.ts";

export type Song = {
  id: SongId;
  name: string;
  author: string;
  mediaId: MediaId;
  projectId: ProjectId | null;
  uploadedBy: UserId | null;
  analysis: SongAnalysis | null;
};

export type SongAnalysis = {
  transcription: { secStart: number; secEnd: number; text: string }[];
  melody: { secStart: number; secEnd: number; text: string }[];
};
