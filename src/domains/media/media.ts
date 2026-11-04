import { type Db, sql } from "../../integrations/db/index.ts";
import type { MediaId, UserId } from "../../types/id.ts";
import type {
  MediaAudioFormat,
  MediaCamera,
  MediaDimension,
  MediaItem,
  MediaPhotoFormat,
  MediaPlace,
  MediaVideoFormat,
} from "../../types/mediaItem.ts";

type MediaRow = {
  id: MediaId;
  kind: "photo" | "video" | "audio";
  storageKey: string;
  uploadedBy: UserId | null;
  format: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  capturedAt: Date | null;
  cameraModel: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  iso: number | null;
  exposureEv: number | null;
  shutter: string | null;
  latitude: number | null;
  longitude: number | null;
  placeEditedAt: Date | null;
};

const columns = sql`
  id,
  kind,
  storage_key as "storageKey",
  uploaded_by as "uploadedBy",
  format,
  bytes,
  width,
  height,
  duration,
  captured_at as "capturedAt",
  camera_model as "cameraModel",
  focal_length_mm as "focalLengthMm",
  aperture,
  iso,
  exposure_ev as "exposureEv",
  shutter,
  latitude,
  longitude,
  place_edited_at as "placeEditedAt"
`;

const placeOf = (row: MediaRow): MediaPlace | null =>
  row.latitude === null || row.longitude === null
    ? null
    : { latitude: row.latitude, longitude: row.longitude, editedAt: row.placeEditedAt };

const cameraOf = (row: MediaRow): MediaCamera | null =>
  row.cameraModel === null &&
  row.focalLengthMm === null &&
  row.aperture === null &&
  row.iso === null &&
  row.exposureEv === null &&
  row.shutter === null
    ? null
    : {
        model: row.cameraModel,
        focalLengthMm: row.focalLengthMm,
        exposure: {
          aperture: row.aperture,
          iso: row.iso,
          ev: row.exposureEv,
          shutter: row.shutter,
        },
      };

const dimensionsOf = (row: MediaRow): MediaDimension | null =>
  row.width === null || row.height === null ? null : { width: row.width, height: row.height };

const durationOf = (row: MediaRow): number | null => row.duration;

const toMedia = (row: MediaRow): MediaItem => {
  const base = { id: row.id, storageKey: row.storageKey, uploadedBy: row.uploadedBy };
  const at = row.capturedAt;
  const place = placeOf(row);
  const camera = cameraOf(row);
  if (row.kind === "photo") {
    return {
      ...base,
      kind: "photo",
      format: row.format as MediaPhotoFormat,
      bytes: row.bytes,
      dimensions: dimensionsOf(row),
      metadata: { at, place, camera },
    };
  }
  if (row.kind === "video") {
    return {
      ...base,
      kind: "video",
      format: row.format as MediaVideoFormat,
      bytes: row.bytes,
      dimensions: dimensionsOf(row),
      duration: durationOf(row),
      metadata: { at, place, camera },
    };
  }
  return {
    ...base,
    kind: "audio",
    format: row.format as MediaAudioFormat,
    bytes: row.bytes,
    duration: durationOf(row),
    metadata: { at, place },
  };
};

export type NewPhotoMedia = {
  kind: "photo";
  storageKey: string;
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
  uploadedBy: UserId | null;
  format: MediaAudioFormat;
  bytes: number;
  duration: number | null;
  capturedAt: Date | null;
  place: MediaPlace | null;
};

export type NewMedia = NewPhotoMedia | NewVideoMedia | NewAudioMedia;

export async function getMedia(id: MediaId): Promise<MediaItem | undefined> {
  const [row] = await sql<MediaRow[]>`select ${columns} from media_items where id = ${id}`;
  return row && toMedia(row);
}

export async function createMedia(input: NewMedia, db: Db = sql): Promise<MediaItem> {
  const [row] = await db<MediaRow[]>`
    insert into media_items (
      kind,
      storage_key,
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
    returning ${columns}
  `;
  if (!row) throw new Error("media insert returned no row");
  return toMedia(row);
}

export async function setMediaPlace(id: MediaId, place: MediaPlace | null): Promise<boolean> {
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

export async function setCapturedAt(id: MediaId, capturedAt: Date | null): Promise<boolean> {
  const rows = await sql`
    update media_items set captured_at = ${capturedAt} where id = ${id} returning id
  `;
  return rows.length > 0;
}

export async function deleteMediaRows(ids: MediaId[], db: Db = sql): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db<{ storageKey: string }[]>`
    delete from media_items where id = any(${ids}) returning storage_key as "storageKey"
  `;
  return rows.map((row) => row.storageKey);
}
