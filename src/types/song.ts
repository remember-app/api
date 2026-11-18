import type { MediaId, SongId, UserId } from "./id.ts";
import type { AnalysisSegment, AnalysisTags } from "./project.ts";

export type SongAIAnalysis = {
  summary: string;
  description: string;
  tags: AnalysisTags | null;
  sounds: AnalysisSegment[] | null;
  words: AnalysisSegment[] | null;
};

export type Song = {
  id: SongId;
  name: string;
  author: string | null;
  originalId: MediaId;
  compressedId: MediaId | null;
  coverId: MediaId | null;
  previewCoverId: MediaId | null;
  duration: number | null;
  uploadedBy: UserId | null;
  analysis: SongAIAnalysis | null;
};
