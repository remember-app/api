import { type Db, sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, UserId } from "../../types/id.ts";
import type {
  MediaAudioFormat,
  MediaCamera,
  MediaDimension,
  MediaItem,
  MediaPhotoFormat,
  MediaPlace,
  MediaVideoFormat,
} from "../../types/mediaItem.ts";
import { adjustStorageSpend } from "../consumable/commands.ts";
import { accessOf, isAdmin } from "../project/access.ts";
import { getItemByMedia } from "../project/item/queries.ts";
import { type MediaRow, mediaColumns, toMedia } from "./internal.ts";
import { getMedia } from "./queries.ts";

export type NewPhotoMedia = {
  kind: "photo";
  storageKey: string;
  fingerprint: string;
  uploadedBy: UserId | null;
  format: MediaPhotoFormat;
  bytes: number;
  dimensions: MediaDimension | null;
  capturedAt: Date | null;
  place: MediaPlace | null;
  camera: MediaCamera | null;
};

export type NewVideoMedia = {
  kind: "video";
  storageKey: string;
  fingerprint: string;
  uploadedBy: UserId | null;
  format: MediaVideoFormat;
  bytes: number;
  dimensions: MediaDimension | null;
  duration: number | null;
  capturedAt: Date | null;
  place: MediaPlace | null;
  camera: MediaCamera | null;
};

export type NewAudioMedia = {
  kind: "audio";
  storageKey: string;
  fingerprint: string;
  uploadedBy: UserId | null;
  format: MediaAudioFormat;
  bytes: number;
  duration: number | null;
  capturedAt: Date | null;
  place: MediaPlace | null;
};

export type NewMedia = NewPhotoMedia | NewVideoMedia | NewAudioMedia;

export async function createMedia(input: NewMedia, db: Db = sql): Promise<MediaItem> {
  const [row] = await db<MediaRow[]>`
    insert into media_items (
      kind,
      storage_key,
      fingerprint,
      uploaded_by,
      format,
      bytes,
      width,
      height,
      duration,
      captured_at,
      camera_model,
      focal_length_mm,
      aperture,
      iso,
      exposure_ev,
      shutter,
      latitude,
      longitude
    )
    values (
      ${input.kind},
      ${input.storageKey},
      ${input.fingerprint},
      ${input.uploadedBy},
      ${input.format},
      ${input.bytes},
      ${"dimensions" in input ? (input.dimensions?.width ?? null) : null},
      ${"dimensions" in input ? (input.dimensions?.height ?? null) : null},
      ${"duration" in input ? input.duration : null},
      ${input.capturedAt},
      ${"camera" in input ? (input.camera?.model ?? null) : null},
      ${"camera" in input ? (input.camera?.focalLengthMm ?? null) : null},
      ${"camera" in input ? (input.camera?.exposure.aperture ?? null) : null},
      ${"camera" in input ? (input.camera?.exposure.iso ?? null) : null},
      ${"camera" in input ? (input.camera?.exposure.ev ?? null) : null},
      ${"camera" in input ? (input.camera?.exposure.shutter ?? null) : null},
      ${input.place?.latitude ?? null},
      ${input.place?.longitude ?? null}
    )
    returning ${mediaColumns}
  `;
  if (!row) throw new Error("media insert returned no row");
  return toMedia(row);
}

async function setMediaPlace(id: MediaId, place: MediaPlace | null): Promise<boolean> {
  const rows = await sql`
    update media_items
    set latitude = ${place?.latitude ?? null},
        longitude = ${place?.longitude ?? null},
        place_edited_at = ${place === null ? null : new Date()}
    where id = ${id}
    returning id
  `;
  return rows.length > 0;
}

async function setCapturedAt(id: MediaId, capturedAt: Date | null): Promise<boolean> {
  const rows = await sql`
    update media_items set captured_at = ${capturedAt} where id = ${id} returning id
  `;
  return rows.length > 0;
}

export async function deleteMediaRows(ids: MediaId[], db: Db = sql): Promise<string[]> {
  if (ids.length === 0) return [];
  const children = await db<{ storageKey: string }[]>`
    delete from media_items
    where parent_media_id = any(${ids}) and uploaded_by is not null
    returning storage_key as "storageKey"
  `;
  const rows = await db<{ storageKey: string }[]>`
    delete from media_items
    where id = any(${ids}) and uploaded_by is not null
    returning storage_key as "storageKey"
  `;
  return [...children, ...rows].map((row) => row.storageKey);
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
  if (!isAdmin(access) && media.uploadedBy !== viewerId) return { denial: "forbidden" };
  if (!(await getItemByMedia(projectId, mediaId))) return { denial: "not_found" };
  if (patch.capturedAt !== undefined) await setCapturedAt(mediaId, patch.capturedAt);
  if (patch.latitude !== undefined && patch.longitude !== undefined) {
    await setMediaPlace(
      mediaId,
      patch.latitude === null || patch.longitude === null
        ? null
        : { latitude: patch.latitude, longitude: patch.longitude, editedAt: new Date() },
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
  if (!isAdmin(access) && media.uploadedBy !== viewerId) return { denial: "forbidden" };
  const item = await getItemByMedia(projectId, mediaId);
  if (!item) return { denial: "not_found" };
  const mediaIds = [
    mediaId,
    ...(item.derivedMedia.thumbnailId ? [item.derivedMedia.thumbnailId] : []),
    ...("previewId" in item.derivedMedia && item.derivedMedia.previewId
      ? [item.derivedMedia.previewId]
      : []),
  ];
  const keys = await sql.begin(async (tx) => {
    if (mediaId === item.mediaId && media.uploadedBy) {
      await adjustStorageSpend(tx, projectId, media.uploadedBy, -media.bytes);
    }
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
