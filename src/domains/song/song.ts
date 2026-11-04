import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { MediaId, ProjectId, SongId, UserId } from "../../types/id.ts";
import type { Song } from "../../types/song.ts";
import { deleteMediaRows } from "../media/media.ts";

const columns = sql`
  id,
  name,
  author,
  media_id as "mediaId",
  project_id as "projectId",
  uploaded_by as "uploadedBy"
`;

export async function getSong(id: SongId): Promise<Song | undefined> {
  const [row] = await sql<Song[]>`select ${columns} from songs where id = ${id}`;
  return row;
}

export async function listLibrarySongs(limit: number, offset: number): Promise<Page<Song>> {
  const rows = await sql<Song[]>`
    select ${columns} from songs where project_id is null
    order by name, id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export async function listProjectSongs(
  projectId: ProjectId,
  limit: number,
  offset: number,
): Promise<Page<Song>> {
  const rows = await sql<Song[]>`
    select ${columns} from songs where project_id = ${projectId}
    order by name, id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export type NewSong = {
  name: string;
  author: string;
  mediaId: MediaId;
  projectId: ProjectId | null;
  uploadedBy: UserId | null;
};

export async function createSong(input: NewSong): Promise<Song> {
  const [row] = await sql<Song[]>`
    insert into songs (name, author, media_id, project_id, uploaded_by)
    values (${input.name}, ${input.author}, ${input.mediaId}, ${input.projectId}, ${input.uploadedBy})
    returning ${columns}
  `;
  if (!row) throw new Error("song insert returned no row");
  return row;
}

export async function deleteSongWithMedia(
  id: SongId,
  projectId: ProjectId,
): Promise<string | undefined> {
  return sql.begin(async (tx) => {
    const [song] = await tx<{ mediaId: MediaId }[]>`
      delete from songs
      where id = ${id} and project_id = ${projectId}
      returning media_id as "mediaId"
    `;
    if (!song) return undefined;
    const [key] = await deleteMediaRows([song.mediaId], tx);
    return key;
  });
}

export async function songsForOrder(projectId: ProjectId, mediaIds: MediaId[]): Promise<Song[]> {
  if (mediaIds.length === 0) return [];
  return sql<Song[]>`
    select ${columns}
    from songs
    where media_id = any(${mediaIds})
      and (project_id is null or project_id = ${projectId})
    order by name, id
  `;
}
