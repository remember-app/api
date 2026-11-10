import type { PageResponse } from "./common.ts";
import type { MontageResponse } from "./montage.ts";

export type MovieVideoResponse = {
  durationSeconds: number | null;
  bytes: number;
  width: number | null;
  height: number | null;
  format: string;
};

export type MovieResponse = {
  id: string;
  name: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  montageId: string;
  videoId: string;
  video: MovieVideoResponse | null;
  montage: MontageResponse | null;
  derived: {
    thumbnailId: string | null;
    previewId: string | null;
  };
  video_url: string | null;
  poster_url: string | null;
  preview_url: string | null;
};

export type MoviesPageResponse = PageResponse<MovieResponse>;
