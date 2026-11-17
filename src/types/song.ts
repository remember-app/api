import type { MediaId, SongId, UserId } from "./id.ts";
import type { AnalysisLevel, AnalysisSegment, AnalysisTags } from "./project.ts";

export type SongAIAnalysis = {
  level: AnalysisLevel;
  score: number;
  summary: string;
  description: string;
  tags: AnalysisTags | null;
  sounds: AnalysisSegment[] | null;
  words: AnalysisSegment[] | null;
};

export type Song = {
  id: SongId;
  name: string;
  author: string;
  mediaId: MediaId;
  coverId: MediaId | null;
  description: string | null;
  uploadedBy: UserId | null;
  analysis: SongAIAnalysis | null;
};
