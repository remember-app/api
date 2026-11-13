import type { MediaKind } from "./types/mediaItem.ts";
import type { AnalysisLevel } from "./types/project.ts";

export const LEVEL_RANK: Record<AnalysisLevel, number> = { low: 0, medium: 1, high: 2 };

export function rank(level: AnalysisLevel | null | undefined): number {
  return LEVEL_RANK[level ?? "low"];
}

export function effectiveAnalysisLevel(kind: MediaKind, level: AnalysisLevel): AnalysisLevel {
  return kind === "video" ? level : "high";
}

export function analysisLevelOf(analysis: unknown): AnalysisLevel {
  const level = (analysis as { level?: unknown } | null)?.level;
  return level === "medium" || level === "high" ? level : "low";
}

export function analysisSatisfies(analysis: unknown, level: AnalysisLevel): boolean {
  return analysis !== null && rank(analysisLevelOf(analysis)) >= rank(level);
}
