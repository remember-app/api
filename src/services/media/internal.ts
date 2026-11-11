import { sql } from "../../integrations/db/index.ts";
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

export type MediaRow = {
  id: MediaId;
  kind: "photo" | "video" | "audio";
  storageKey: string;
  fingerprint: string;
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

export const mediaColumns = sql`
  id,
  kind,
  storage_key as "storageKey",
  fingerprint,
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

export const toMedia = (row: MediaRow): MediaItem => {
  const base = {
    id: row.id,
    storageKey: row.storageKey,
    fingerprint: row.fingerprint,
    uploadedBy: row.uploadedBy,
  };
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
      duration: row.duration,
      metadata: { at, place, camera },
    };
  }
  return {
    ...base,
    kind: "audio",
    format: row.format as MediaAudioFormat,
    bytes: row.bytes,
    duration: row.duration,
    metadata: { at, place },
  };
};
