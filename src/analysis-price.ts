import type { AnalysisPrice } from "./services/settings/defaults.ts";
import type { MediaKind } from "./types/mediaItem.ts";
import type { AnalysisLevel } from "./types/project.ts";

export type AnalysisPriced = {
  kind: MediaKind;
  level: AnalysisLevel;
  duration: number | null;
};

// Must match the worker's low-level sampling in src/media/analysis.py.
const FRAME_STEP_SECONDS = 5;
const FRAME_MIN = 3;
const FRAME_MAX = 60;

export function videoFrames(duration: number | null): number {
  if (!duration || duration <= 0) return FRAME_MIN;
  return Math.max(FRAME_MIN, Math.min(FRAME_MAX, Math.ceil(duration / FRAME_STEP_SECONDS)));
}

export function analysisCost(price: AnalysisPrice, item: AnalysisPriced): number {
  const rate = price[item.kind]?.[item.level];
  if (!rate) throw new Error(`analysis.price has no rate for ${item.kind} ${item.level}`);
  if (rate.unit === "file") return rate.tokens;
  if (rate.unit === "frame") return rate.tokens * videoFrames(item.duration);
  return rate.tokens * (item.duration ?? 0);
}

// Balances are whole tokens, so the total of fractional rates is rounded up once.
export function quoteTokens(price: AnalysisPrice, items: AnalysisPriced[]): number {
  return Math.ceil(items.reduce((sum, item) => sum + analysisCost(price, item), 0));
}
