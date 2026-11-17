import type { PageResponse } from "./common.ts";

export type SongResponse = {
  id: string;
  name: string;
  author: string | null;
  mediaId: string;
  coverId: string | null;
  coverUrl: string | null;
  description: string | null;
  uploadedBy: string | null;
};

export type SongWithUrlResponse = SongResponse & {
  url: string;
};

export type SongsPageResponse = PageResponse<SongResponse>;

export type CreateSongRequest = {
  name: string;
  author?: string | null;
  mediaId: string;
  coverId?: string | null;
  description?: string | null;
};

export type UpdateSongRequest = {
  name?: string;
  author?: string | null;
  coverId?: string | null;
  description?: string | null;
};
