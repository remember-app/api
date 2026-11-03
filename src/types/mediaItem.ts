import type { MediaId, UserId } from "./id.ts";

export type MediaItem = PhotoMedia | VideoMedia | AudioMedia;

export type MediaKind = MediaItem["kind"];

export type PhotoMedia = MediaItemCommon & {
  kind: "photo";
  format: MediaPhotoFormat;
  bytes: number;
  dimensions: MediaDimension | null;
  metadata: PhotoMediaMetadata;
};

export type VideoMedia = MediaItemCommon & {
  kind: "video";
  format: MediaVideoFormat;
  bytes: number;
  dimensions: MediaDimension | null;
  duration: number | null;
  metadata: VideoMediaMetadata;
};

export type AudioMedia = MediaItemCommon & {
  kind: "audio";
  format: MediaAudioFormat;
  bytes: number;
  duration: number | null;
  metadata: AudioMediaMetadata;
};

export type MediaItemCommon = {
  id: MediaId;
  storageKey: string;
  uploadedBy: UserId | null;
};

export type PhotoMediaMetadata = {
  at: Date | null;
  place: MediaPlace | null;
  camera: MediaCamera | null;
};

export type VideoMediaMetadata = {
  at: Date | null;
  place: MediaPlace | null;
  camera: MediaCamera | null;
};

export type AudioMediaMetadata = {
  at: Date | null;
  place: MediaPlace | null;
};

export type MediaPhotoFormat = "jpeg" | "png" | "heic" | "webp";

export type MediaVideoFormat = "mp4" | "mov";

export type MediaAudioFormat = "mp3" | "m4a" | "wav";

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
  editedAt: Date | null;
};
