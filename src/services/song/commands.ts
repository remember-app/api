import { sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, SongId, UserId } from "../../types/id.ts";
import type { Song } from "../../types/song.ts";
import { adjustStorageSpend, adjustUserStorageSpend } from "../consumable/commands.ts";
import { deleteMediaRows } from "../media/commands.ts";
import { getMedia } from "../media/queries.ts";
import { accessOf, isAdmin } from "../project/access.ts";
import { songColumns } from "./internal.ts";
import { getSong } from "./queries.ts";

export type SongDenial = { denial: "not_found" | "forbidden" | "bad_request" };

export async function createSong(
  projectId: ProjectId,
  viewerId: UserId,
  input: {
    name: string;
    author: string;
    mediaId: MediaId;
    coverId?: MediaId | null;
    description?: string | null;
  },
): Promise<{ song: Song } | SongDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (!isAdmin(access)) return { denial: "forbidden" };
  const media = await getMedia(input.mediaId);
  if (!media || media.kind !== "audio") return { denial: "bad_request" };
  if (media.uploadedBy !== viewerId) {
    const [owned] = await sql<{ one: number }[]>`
      select 1 as one from project_items
      where project_id = ${projectId} and media_id = ${media.id}
      limit 1
    `;
    if (!owned) return { denial: "bad_request" };
  }
  if (input.coverId) {
    const cover = await getMedia(input.coverId);
    if (cover?.kind !== "photo") return { denial: "bad_request" };
  }
  const song = await sql.begin(async (tx) => {
    const [row] = await tx<Song[]>`
      insert into songs (name, author, media_id, uploaded_by, cover_id, description)
      values (
        ${input.name},
        ${input.author},
        ${media.id},
        ${viewerId},
        ${input.coverId ?? null},
        ${input.description ?? null}
      )
      returning ${songColumns}
    `;
    if (!row) throw new Error("song insert returned no row");
    await tx`
      insert into project_songs (project_id, song_id, added_by)
      values (${projectId}, ${row.id}, ${viewerId})
      on conflict do nothing
    `;
    return row;
  });
  return { song };
}

export async function attachSong(
  projectId: ProjectId,
  songId: SongId,
  viewerId: UserId,
): Promise<{ song: Song } | SongDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (!isAdmin(access)) return { denial: "forbidden" };
  const song = await getSong(songId);
  if (!song) return { denial: "not_found" };
  if (song.uploadedBy !== null && song.uploadedBy !== viewerId) {
    return { denial: "forbidden" };
  }
  await sql`
    insert into project_songs (project_id, song_id, added_by)
    values (${projectId}, ${songId}, ${viewerId})
    on conflict do nothing
  `;
  return { song };
}

export async function detachSong(
  projectId: ProjectId,
  songId: SongId,
  viewerId: UserId,
): Promise<{ ok: true } | SongDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (!isAdmin(access)) return { denial: "forbidden" };
  const [row] = await sql<{ songId: SongId }[]>`
    delete from project_songs
    where project_id = ${projectId} and song_id = ${songId}
    returning song_id as "songId"
  `;
  if (!row) return { denial: "not_found" };
  return { ok: true };
}

export async function deleteOwnSong(
  songId: SongId,
  viewerId: UserId,
): Promise<{ keys: string[] } | SongDenial> {
  const song = await getSong(songId);
  if (!song) return { denial: "not_found" };
  if (song.uploadedBy === null || song.uploadedBy !== viewerId) {
    return { denial: "forbidden" };
  }
  const keys = await sql.begin(async (tx) => {
    await tx`delete from songs where id = ${songId}`;
    const media = await getMedia(song.mediaId);
    if (media?.uploadedBy) {
      const [origin] = await tx<{ projectId: ProjectId | null }[]>`
        select project_id as "projectId" from uploads
        where media_id = ${media.id}
        limit 1
      `;
      if (origin?.projectId) {
        await adjustStorageSpend(tx, origin.projectId, media.uploadedBy, -media.bytes);
      } else if (origin) {
        await adjustUserStorageSpend(tx, media.uploadedBy, -media.bytes);
      }
    }
    return deleteMediaRows([song.mediaId], tx);
  });
  return { keys };
}
