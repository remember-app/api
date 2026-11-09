import { sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, ProjectItemId } from "../../types/id.ts";
import type { MediaKind } from "../../types/mediaItem.ts";
import type { MontageSetting, MontageSource } from "../../types/montage.ts";
import { songsForOrder } from "../song/queries.ts";

export type ResolvedOrderItem = {
  itemId: ProjectItemId;
  mediaId: MediaId;
  kind: MediaKind;
  analyzed: boolean;
};

export type ResolvedOrderSong = {
  mediaId: MediaId;
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

  const items = await sql<ResolvedOrderItem[]>`
    select
      pi.id as "itemId",
      pi.media_id as "mediaId",
      pi.kind,
      (pi.analysis is not null) as analyzed
    from project_items pi
    where pi.project_id = ${projectId} and pi.id = any(${config.includeItemIds})
  `;
  const found = new Set(items.map((item) => item.itemId));
  for (const id of config.includeItemIds) {
    if (!found.has(id)) problems.push(`item ${id} does not belong to this project`);
  }

  const songs = await songsForOrder(projectId, config.musicIds);
  const foundSongs = new Set(songs.map((song) => song.mediaId));
  for (const id of config.musicIds) {
    if (!foundSongs.has(id)) problems.push(`song ${id} is not available to this project`);
  }

  return {
    problems,
    items,
    songs: songs.map((song) => ({ mediaId: song.mediaId, analyzed: song.analysis !== null })),
  };
}
