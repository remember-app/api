import { type Db, sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, UserId } from "../../types/id.ts";
import type { MediaFormat, MediaItem, MediaKind, MediaMeta } from "../../types/mediaItem.ts";
import { adjustStorageSpend } from "../consumable/commands.ts";
import { accessOf, isAdmin } from "../project/access.ts";
import { getItemByMedia } from "../project/item/queries.ts";
import { type MediaRow, mediaColumns, toMedia } from "./internal.ts";
import { getMedia } from "./queries.ts";

export type NewMedia = {
  kind: MediaKind;
  storageKey: string;
  fingerprint: string;
  format: MediaFormat;
  bytes: number;
  meta: MediaMeta;
};

export async function createMedia(input: NewMedia, db: Db = sql): Promise<MediaItem> {
  const [row] = await db<MediaRow[]>`
    insert into media_items (kind, storage_key, fingerprint, format, bytes, meta)
    values (
      ${input.kind},
      ${input.storageKey},
      ${input.fingerprint},
      ${input.format},
      ${input.bytes},
      ${sql.json(input.meta)}
    )
    returning ${mediaColumns}
  `;
  if (!row) throw new Error("media insert returned no row");
  return toMedia(row);
}

async function setMediaPlace(
  id: MediaId,
  place: { latitude: number; longitude: number } | null,
): Promise<boolean> {
  const rows =
    place === null
      ? await sql`
        update media_items
        set meta = jsonb_set(meta, '{place}', 'null'::jsonb)
        where id = ${id}
        returning id
      `
      : await sql`
        update media_items
        set meta = jsonb_set(meta, '{place}', ${sql.json(place)})
        where id = ${id}
        returning id
      `;
  return rows.length > 0;
}

async function setCapturedAt(id: MediaId, capturedAt: Date | null): Promise<boolean> {
  const rows =
    capturedAt === null
      ? await sql`
        update media_items
        set meta = jsonb_set(meta, '{at}', 'null'::jsonb)
        where id = ${id}
        returning id
      `
      : await sql`
        update media_items
        set meta = jsonb_set(meta, '{at}', to_jsonb(${capturedAt.toISOString()}::text))
        where id = ${id}
        returning id
      `;
  return rows.length > 0;
}

export async function deleteMediaRows(ids: MediaId[], db: Db = sql): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db<{ storageKey: string }[]>`
    delete from media_items
    where id = any(${ids})
    returning storage_key as "storageKey"
  `;
  return rows.map((row) => row.storageKey);
}

export type MediaDenial = { denial: "not_found" | "forbidden" };

export type MediaPatch = {
  capturedAt?: Date | null;
  latitude?: number | null;
  longitude?: number | null;
};

export async function updateMedia(
  projectId: ProjectId,
  mediaId: MediaId,
  viewerId: UserId,
  patch: MediaPatch,
): Promise<{ media: MediaItem } | MediaDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  const media = await getMedia(mediaId);
  if (!media) return { denial: "not_found" };
  const item = await getItemByMedia(projectId, mediaId);
  if (!item) return { denial: "not_found" };
  if (!isAdmin(access) && item.uploadedBy !== viewerId) return { denial: "forbidden" };
  if (patch.capturedAt !== undefined) await setCapturedAt(mediaId, patch.capturedAt);
  if (patch.latitude !== undefined && patch.longitude !== undefined) {
    await setMediaPlace(
      mediaId,
      patch.latitude === null || patch.longitude === null
        ? null
        : { latitude: patch.latitude, longitude: patch.longitude },
    );
  }
  const updated = await getMedia(mediaId);
  if (!updated) return { denial: "not_found" };
  return { media: updated };
}

export async function removeMedia(
  projectId: ProjectId,
  mediaId: MediaId,
  viewerId: UserId,
): Promise<{ keys: string[] } | MediaDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  const media = await getMedia(mediaId);
  if (!media) return { denial: "not_found" };
  const item = await getItemByMedia(projectId, mediaId);
  if (!item) return { denial: "not_found" };
  if (!isAdmin(access) && item.uploadedBy !== viewerId) return { denial: "forbidden" };
  const mediaIds = [
    item.originalId,
    item.compressedId,
    ...Object.values(item.previewsIds ?? {}),
  ].filter((id): id is MediaId => id !== undefined && id !== null);
  const keys = await sql.begin(async (tx) => {
    await adjustStorageSpend(tx, projectId, item.uploadedBy, -media.bytes);
    await tx`delete from project_items where project_id = ${projectId} and id = ${item.id}`;
    await tx`
      delete from jobs
      where ref = any(${mediaIds})
         or ref in (select id from uploads where media_id = any(${mediaIds}))
    `;
    return deleteMediaRows(mediaIds, tx);
  });
  return { keys };
}
