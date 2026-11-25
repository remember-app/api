import type { PageResponse } from "./common.ts";

export type SongResponse = {
  id: string;
  name: string;
  author: string | null;
  originalId: string;
  compressedId: string | null;
  coverId: string | null;
  previewCoverId: string | null;
  coverUrl: string | null;
  previewCoverUrl: string | null;
  duration: number | null;
  uploadedBy: string | null;
};

export type SongWithUrlResponse = SongResponse & {
  url: string;
};

export type SongsPageResponse = PageResponse<SongResponse>;

export type CreateSongRequest = {
  name: string;
  author?: string | null;
  originalId: string;
  coverId?: string | null;
  previewCoverId?: string | null;
};

export type UpdateSongRequest = {
  name?: string;
  author?: string | null;
  coverId?: string | null;
  previewCoverId?: string | null;
};
