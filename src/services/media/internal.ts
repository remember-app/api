import { sql } from "../../integrations/db/index.ts";
import type { MediaId } from "../../types/id.ts";
import type { MediaCamera, MediaFormat, MediaItem, MediaKind } from "../../types/mediaItem.ts";

type MetaRow = {
  dimensions?: { width: number; height: number } | null;
  duration?: number | null;
  at?: string | null;
  place?: { latitude: number; longitude: number } | null;
  camera?: MediaCamera | null;
};

export type MediaRow = {
  id: MediaId;
  kind: MediaKind;
  storageKey: string;
  fingerprint: string;
  perceptualHash: string;
  format: string;
  bytes: string;
  meta: MetaRow;
};

export const mediaColumns = sql`
  id,
  kind,
  storage_key as "storageKey",
  fingerprint,
  perceptual_hash as "perceptualHash",
  format,
  bytes,
  meta
`;

const dateOrNull = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const toMedia = (row: MediaRow): MediaItem => {
  const meta = row.meta ?? {};
  return {
    id: row.id,
    kind: row.kind,
    storageKey: row.storageKey,
    fingerprint: row.fingerprint,
    perceptualHash: row.perceptualHash,
    format: row.format as MediaFormat,
    bytes: Number(row.bytes),
    meta: {
      dimensions: meta.dimensions ?? null,
      duration: meta.duration ?? null,
      at: dateOrNull(meta.at),
      place: meta.place ?? null,
      camera: meta.camera ?? null,
    },
  };
};
