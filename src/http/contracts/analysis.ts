import type { AnalysisResponse, MediaKind } from "./media.ts";

export type AnalyzeItemsRequest = {
  itemIds: string[];
};

export type AnalyzeItemsResponse = {
  queued: number;
  tokens: number;
};

export type AnalysisJobStatus = "queued" | "running" | "done" | "failed";

export type AnalysisJobResponse = {
  itemId: string;
  mediaId: string;
  kind: MediaKind;
  status: AnalysisJobStatus;
  error: string | null;
  analysis: AnalysisResponse | null;
};

export type AnalysisJobsResponse = {
  items: AnalysisJobResponse[];
};
