import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { MediaId, ProjectId, SongId, UserId } from "../../types/id.ts";
import type { Song } from "../../types/song.ts";
import { accessOf } from "../project/access.ts";
import { songColumns } from "./internal.ts";

export async function getSong(id: SongId): Promise<Song | undefined> {
  const [row] = await sql<Song[]>`select ${songColumns} from songs where id = ${id}`;
  return row;
}

export async function listLibrarySongs(limit: number, offset: number): Promise<Page<Song>> {
  const rows = await sql<Song[]>`
    select ${songColumns} from songs where project_id is null
    order by name, id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export async function listProjectSongs(
  projectId: ProjectId,
  viewerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<Song> | undefined> {
  if (!(await accessOf(projectId, viewerId))) return undefined;
  const rows = await sql<Song[]>`
    select ${songColumns} from songs where project_id = ${projectId}
    order by name, id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export async function songsForOrder(projectId: ProjectId, mediaIds: MediaId[]): Promise<Song[]> {
  if (mediaIds.length === 0) return [];
  return sql<Song[]>`
    select ${songColumns}
    from songs
    where media_id = any(${mediaIds})
      and (project_id is null or project_id = ${projectId})
    order by name, id
  `;
}
