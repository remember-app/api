import type { AISessionId, JobId } from "./id.ts";

export type AIProvider = "gemini";

export type AISessionOperation = "photo" | "video" | "audio" | "text";

export type AISessionStatus = "ok" | "failed";

export type AIToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type AIToolResult = {
  callId: string;
  name: string;
  text: string;
  isError: boolean;
};

export type AITranscriptEntry = {
  at: string;
  input: {
    text: string;
    blobs: string[];
    toolResults: AIToolResult[];
  };
  output: {
    text: string;
    toolCalls: AIToolCall[];
    interactionId: string | null;
  };
};

export type AITranscript = AITranscriptEntry[];

export type AISession = {
  id: AISessionId;
  jobId: JobId;
  operation: AISessionOperation;
  provider: AIProvider;
  model: string;
  status: AISessionStatus;
  usage: AIUsage;
  error: string | null;
  transcript: AITranscript;
  createdAt: Date;
  updatedAt: Date;
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
};
