import type { PageResponse } from "./common.ts";

export type MovieResponse = {
  id: string;
  name: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  montageId: string;
  videoId: string;
  derived: {
    thumbnailId: string | null;
    previewId: string | null;
  };
  video_url: string | null;
  poster_url: string | null;
  preview_url: string | null;
};

export type MoviesPageResponse = PageResponse<MovieResponse>;
