import { type Db, sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, SongId, UserId } from "../../types/id.ts";
import type { Song } from "../../types/song.ts";
import { adjustStorageSpend, adjustUserStorageSpend } from "../consumable/commands.ts";
import { deleteMediaRows } from "../media/commands.ts";
import { getMedia } from "../media/queries.ts";
import { accessOf, isAdmin } from "../project/access.ts";
import { songColumns } from "./internal.ts";
import { getSong } from "./queries.ts";

export type SongDenial = { denial: "not_found" | "forbidden" | "bad_request" };

export type SongInput = {
  name: string;
  author?: string | null;
  originalId: MediaId;
  coverId?: MediaId | null;
  previewCoverId?: MediaId | null;
};

export type SongPatch = {
  name?: string;
  author?: string | null;
  coverId?: MediaId | null;
  previewCoverId?: MediaId | null;
};

async function coverAllowed(id: MediaId | null | undefined): Promise<boolean> {
  if (!id) return true;
  const cover = await getMedia(id);
  return cover?.kind === "photo";
}

async function ownedOwnMedia(mediaId: MediaId, viewerId: UserId): Promise<boolean> {
  const [owned] = await sql<{ one: number }[]>`
    select 1 as one from uploads
    where media_id = ${mediaId} and project_id is null and uploaded_by = ${viewerId}
    limit 1
  `;
  return owned !== undefined;
}

type InsertedSong = Omit<Song, "duration">;

async function insertSong(db: Db, viewerId: UserId, input: SongInput): Promise<InsertedSong> {
  const [row] = await db<InsertedSong[]>`
    insert into songs (name, author, original_id, uploaded_by, cover_id, preview_cover_id)
    values (
      ${input.name},
      ${input.author ?? null},
      ${input.originalId},
      ${viewerId},
      ${input.coverId ?? null},
      ${input.previewCoverId ?? null}
    )
    returning ${songColumns}
  `;
  if (!row) throw new Error("song insert returned no row");
  return row;
}

export async function createSong(
  projectId: ProjectId,
  viewerId: UserId,
  input: SongInput,
): Promise<{ song: Song } | SongDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (!isAdmin(access)) return { denial: "forbidden" };
  const media = await getMedia(input.originalId);
  if (!media || media.kind !== "audio") return { denial: "bad_request" };
  const [available] = await sql<{ one: number }[]>`
    select 1 as one from project_items
    where project_id = ${projectId} and original_id = ${media.id}
    limit 1
  `;
  if (!available) return { denial: "bad_request" };
  if (!(await coverAllowed(input.coverId)) || !(await coverAllowed(input.previewCoverId))) {
    return { denial: "bad_request" };
  }
  const songId = await sql.begin(async (tx) => {
    const row = await insertSong(tx, viewerId, { ...input, originalId: media.id });
    await tx`
      insert into project_songs (project_id, song_id, added_by)
      values (${projectId}, ${row.id}, ${viewerId})
      on conflict do nothing
    `;
    return row.id;
  });
  const song = await getSong(songId);
  if (!song) throw new Error("song disappeared after insert");
  return { song };
}

export async function createOwnSong(
  viewerId: UserId,
  input: SongInput,
): Promise<{ song: Song } | SongDenial> {
  const media = await getMedia(input.originalId);
  if (!media || media.kind !== "audio") return { denial: "bad_request" };
  if (!(await ownedOwnMedia(media.id, viewerId))) return { denial: "bad_request" };
  if (!(await coverAllowed(input.coverId)) || !(await coverAllowed(input.previewCoverId))) {
    return { denial: "bad_request" };
  }
  const row = await insertSong(sql, viewerId, { ...input, originalId: media.id });
  const song = await getSong(row.id);
  if (!song) throw new Error("song disappeared after insert");
  return { song };
}

export async function updateOwnSong(
  songId: SongId,
  viewerId: UserId,
  patch: SongPatch,
): Promise<{ song: Song } | SongDenial> {
  const song = await getSong(songId);
  if (!song) return { denial: "not_found" };
  if (song.uploadedBy === null || song.uploadedBy !== viewerId) {
    return { denial: "forbidden" };
  }
  if (!(await coverAllowed(patch.coverId)) || !(await coverAllowed(patch.previewCoverId))) {
    return { denial: "bad_request" };
  }
  const [row] = await sql<InsertedSong[]>`
    update songs
    set name = ${patch.name ?? song.name},
        author = ${patch.author === undefined ? song.author : patch.author},
        cover_id = ${patch.coverId === undefined ? song.coverId : patch.coverId},
        preview_cover_id =
          ${patch.previewCoverId === undefined ? song.previewCoverId : patch.previewCoverId}
    where id = ${songId}
    returning ${songColumns}
  `;
  if (!row) throw new Error("song update returned no row");
  const updated = await getSong(songId);
  if (!updated) throw new Error("song disappeared after update");
  return { song: updated };
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
    const media = await getMedia(song.originalId);
    if (media) {
      const [origin] = await tx<{ projectId: ProjectId | null }[]>`
        select project_id as "projectId" from uploads
        where media_id = ${media.id}
        limit 1
      `;
      if (origin?.projectId) {
        await adjustStorageSpend(tx, origin.projectId, song.uploadedBy!, -media.bytes);
      } else if (origin) {
        await adjustUserStorageSpend(tx, song.uploadedBy!, -media.bytes);
      }
    }
    return deleteMediaRows([song.originalId, song.compressedId].filter(
      (id): id is MediaId => id !== null,
    ), tx);
  });
  return { keys };
}
