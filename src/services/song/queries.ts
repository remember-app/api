import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { MediaId, ProjectId, SongId, UserId } from "../../types/id.ts";
import type { Song } from "../../types/song.ts";
import { accessOf } from "../project/access.ts";
import { songSelect } from "./internal.ts";

export async function getSong(id: SongId): Promise<Song | undefined> {
  const [row] = await sql<Song[]>`
    select ${songSelect}
    from songs s
    join media_items m on m.id = s.original_id
    where s.id = ${id}
  `;
  return row;
}

export async function listLibrarySongs(limit: number, offset: number): Promise<Page<Song>> {
  const rows = await sql<Song[]>`
    select ${songSelect}
    from songs s
    join media_items m on m.id = s.original_id
    where s.uploaded_by is null
    order by s.name, s.id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export async function listOwnSongs(
  viewerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<Song>> {
  const rows = await sql<Song[]>`
    select ${songSelect}
    from songs s
    join media_items m on m.id = s.original_id
    where s.uploaded_by = ${viewerId}
    order by s.name, s.id
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
    select ${songSelect}
    from songs s
    join media_items m on m.id = s.original_id
    join project_songs ps on ps.song_id = s.id
    where ps.project_id = ${projectId}
    order by s.name, s.id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export async function songsForOrder(projectId: ProjectId, mediaIds: MediaId[]): Promise<Song[]> {
  if (mediaIds.length === 0) return [];
  return sql<Song[]>`
    select ${songSelect}
    from songs s
    join media_items m on m.id = s.original_id
    where s.original_id = any(${mediaIds})
      and (
        s.uploaded_by is null
        or exists (
          select 1 from project_songs ps
          where ps.song_id = s.id and ps.project_id = ${projectId}
        )
      )
    order by s.name, s.id
  `;
}
