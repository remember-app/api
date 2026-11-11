import { sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, SongId, UserId } from "../../types/id.ts";
import type { Song } from "../../types/song.ts";
import { adjustStorageSpend } from "../consumable/commands.ts";
import { deleteMediaRows } from "../media/commands.ts";
import { getMedia } from "../media/queries.ts";
import { accessOf, isAdmin } from "../project/access.ts";
import { songColumns } from "./internal.ts";

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
  if (input.coverId) {
    const cover = await getMedia(input.coverId);
    if (cover?.kind !== "photo") return { denial: "bad_request" };
  }
  const [row] = await sql<Song[]>`
    insert into songs (name, author, media_id, project_id, uploaded_by, cover_id, description)
    values (
      ${input.name},
      ${input.author},
      ${media.id},
      ${projectId},
      ${viewerId},
      ${input.coverId ?? null},
      ${input.description ?? null}
    )
    returning ${songColumns}
  `;
  if (!row) throw new Error("song insert returned no row");
  return { song: row };
}

export async function deleteSongWithMedia(
  projectId: ProjectId,
  songId: SongId,
  viewerId: UserId,
): Promise<{ key: string | undefined } | SongDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (!isAdmin(access)) return { denial: "forbidden" };
  const result = await sql.begin(async (tx) => {
    const [song] = await tx<{ mediaId: MediaId }[]>`
      delete from songs
      where id = ${songId} and project_id = ${projectId}
      returning media_id as "mediaId"
    `;
    if (!song) return undefined;
    const media = await getMedia(song.mediaId);
    if (media?.uploadedBy) {
      await adjustStorageSpend(tx, projectId, media.uploadedBy, -media.bytes);
    }
    const [key] = await deleteMediaRows([song.mediaId], tx);
    return { key };
  });
  if (!result) return { denial: "not_found" };
  return result;
}
