import type { MediaId } from "./id.ts";

export type MediaItem = {
  id: MediaId;
  kind: MediaKind;
  storageKey: string;
  format: MediaFormat;
  bytes: number;
  fingerprint: string;
  perceptualHash: string;
  meta: MediaMeta;
};

export type MediaKind = "photo" | "video" | "audio";

export type MediaFormat = MediaPhotoFormat | MediaVideoFormat | MediaAudioFormat;

export type MediaPhotoFormat = "jpeg" | "png" | "heic" | "webp";

export type MediaVideoFormat = "mp4" | "mov";

export type MediaAudioFormat = "mp3" | "m4a" | "wav";

export type MediaMeta = {
  dimensions: MediaDimension | null;
  duration: number | null;
  at: Date | null;
  place: MediaPlace | null;
  camera: MediaCamera | null;
};

export type MediaDimension = {
  width: number;
  height: number;
};

export type MediaExposure = {
  aperture: number | null;
  iso: number | null;
  ev: number | null;
  shutter: string | null;
};

export type MediaCamera = {
  model: string | null;
  focalLengthMm: number | null;
  exposure: MediaExposure;
};

export type MediaPlace = {
  latitude: number;
  longitude: number;
};
