import type { AIRequestId, JobId } from "./id.ts";

export type AIProvider = "gemini";

export type AIRequestOperation = "photo" | "video" | "audio" | "text";

export type AIRequestStatus = "ok" | "failed";

export type AIRequest = {
  id: AIRequestId;
  jobId: JobId;
  operation: AIRequestOperation;
  provider: AIProvider;
  model: string;
  status: AIRequestStatus;
  usage: AIUsage;
  createdAt: Date;
};

export type AIUsage = {
  tokens: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
  };
  duration: number | null;
  costUsd: number | null;
  error: string | null;
};
