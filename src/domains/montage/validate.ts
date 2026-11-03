import { sql } from "../../integrations/db/index.ts";
import type { ProjectId, ProjectItemId } from "../../types/id.ts";
import type { MontageConfig } from "../../types/montage.ts";
import { songsForOrder } from "../song/song.ts";

export async function validateConfig(
  projectId: ProjectId,
  config: MontageConfig,
): Promise<string[]> {
  const problems: string[] = [];
  if (!Number.isInteger(config.targetSeconds) || config.targetSeconds <= 0) {
    problems.push("targetSeconds must be a positive integer");
  }
  if (config.dimensions.width <= 0 || config.dimensions.height <= 0) {
    problems.push("dimensions must be positive");
  }
  const required = new Set(config.requiredMediaIds);
  for (const id of required) {
    if (!config.includeMediaIds.includes(id)) {
      problems.push(`required item ${id} is not among the included items`);
    }
  }
  const named = [...new Set([...config.includeMediaIds, ...config.requiredMediaIds])];
  if (named.length > 0) {
    const known = await sql<{ id: ProjectItemId }[]>`
      select id from project_items
      where project_id = ${projectId} and id = any(${named})
    `;
    const found = new Set(known.map((row) => row.id));
    for (const id of named) {
      if (!found.has(id)) problems.push(`item ${id} does not belong to this project`);
    }
  }
  if (config.musicIds !== null && config.musicIds.length > 0) {
    const songs = await songsForOrder(projectId, config.musicIds);
    const found = new Set(songs.map((song) => song.mediaId));
    for (const id of config.musicIds) {
      if (!found.has(id)) problems.push(`song ${id} is not available to this project`);
    }
  }
  return problems;
}
