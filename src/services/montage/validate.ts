import { sql } from "../../integrations/db/index.ts";
import { analysisSatisfies, effectiveAnalysisLevel } from "../../levels.ts";
import type { MediaId, ProjectId, ProjectItemId } from "../../types/id.ts";
import type { MediaKind } from "../../types/mediaItem.ts";
import type { MontageSetting, MontageSource } from "../../types/montage.ts";
import type { AnalysisLevel } from "../../types/project.ts";
import { songsForOrder } from "../song/queries.ts";

export type ResolvedOrderItem = {
  itemId: ProjectItemId;
  mediaId: MediaId;
  kind: MediaKind;
  duration: number | null;
  analyzed: boolean;
};

export type ResolvedOrderSong = {
  mediaId: MediaId;
  duration: number | null;
  analyzed: boolean;
};

export type ResolvedOrder = {
  problems: string[];
  items: ResolvedOrderItem[];
  songs: ResolvedOrderSong[];
};

const repeated = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) twice.add(value);
    seen.add(value);
  }
  return [...twice];
};

export async function validateOrder(
  projectId: ProjectId,
  config: MontageSetting & MontageSource,
  level: AnalysisLevel,
): Promise<ResolvedOrder> {
  const problems: string[] = [];
  if (!Number.isInteger(config.targetSeconds) || config.targetSeconds <= 0) {
    problems.push("targetSeconds must be a positive integer");
  }
  if (config.dimensions.width <= 0 || config.dimensions.height <= 0) {
    problems.push("dimensions must be positive");
  }
  if (config.includeItemIds.length === 0) {
    problems.push("no items are included");
  }
  for (const id of repeated(config.includeItemIds)) {
    problems.push(`item ${id} is included more than once`);
  }
  for (const id of repeated(config.requiredItemIds)) {
    problems.push(`required item ${id} is listed more than once`);
  }
  for (const id of repeated(config.musicIds)) {
    problems.push(`song ${id} is listed more than once`);
  }
  const included = new Set(config.includeItemIds);
  for (const id of config.requiredItemIds) {
    if (!included.has(id)) problems.push(`required item ${id} is not among the included items`);
  }

  const rows = await sql<
    {
      itemId: ProjectItemId;
      mediaId: MediaId;
      kind: MediaKind;
      duration: number | null;
      analysis: unknown;
    }[]
  >`
    select
      pi.id as "itemId",
      pi.original_id as "mediaId",
      pi.kind,
      nullif(m.meta->>'duration', '')::float8 as "duration",
      pi.analysis
    from project_items pi
    join media_items m on m.id = pi.original_id
    where pi.project_id = ${projectId} and pi.id = any(${config.includeItemIds})
  `;
  const items: ResolvedOrderItem[] = rows.map((row) => ({
    itemId: row.itemId,
    mediaId: row.mediaId,
    kind: row.kind,
    duration: row.duration,
    analyzed: analysisSatisfies(row.analysis, effectiveAnalysisLevel(row.kind, level)),
  }));
  const found = new Set(items.map((item) => item.itemId));
  for (const id of config.includeItemIds) {
    if (!found.has(id)) problems.push(`item ${id} does not belong to this project`);
  }

  const songs = await songsForOrder(projectId, config.musicIds);
  const foundSongs = new Set(songs.map((song) => song.mediaId));
  for (const id of config.musicIds) {
    if (!foundSongs.has(id)) problems.push(`song ${id} is not available to this project`);
  }
  const durations =
    config.musicIds.length > 0
      ? await sql<{ mediaId: MediaId; duration: number | null }[]>`
          select id as "mediaId", nullif(meta->>'duration', '')::float8 as "duration"
          from media_items where id = any(${config.musicIds})
        `
      : [];
  const durationOf = new Map(durations.map((row) => [row.mediaId, row.duration]));

  return {
    problems,
    items,
    songs: songs.map((song) => ({
      mediaId: song.mediaId,
      duration: durationOf.get(song.mediaId) ?? null,
      analyzed: analysisSatisfies(song.analysis, effectiveAnalysisLevel("audio", level)),
    })),
  };
}
