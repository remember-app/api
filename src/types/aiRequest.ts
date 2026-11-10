import type { AIRequestId, MediaId, MontageId } from "./id.ts";

export type AIProvider = "gemini";

export type AIRequestOperation = "photo" | "video" | "audio" | "text";

export type AIRequestStatus = "ok" | "failed";

export type AIRequest = {
  id: AIRequestId;
  mediaId: MediaId | null;
  montageId: MontageId | null;
  operation: AIRequestOperation;
  provider: AIProvider;
  model: string;
  status: AIRequestStatus;
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
    cached: number | null;
    reasoning: number | null;
  };
  duration: number | null;
  costUsd: number | null;
  error: string | null;
  createdAt: Date;
};
