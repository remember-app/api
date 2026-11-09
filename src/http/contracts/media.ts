import type { CursorPageResponse } from "./common.ts";
import type { PublicUserResponse } from "./user.ts";

export type MediaKind = "photo" | "video" | "audio";

export type PlaceResponse = {
  latitude: number;
  longitude: number;
};

export type ExposureResponse = {
  aperture: number | null;
  iso: number | null;
  ev: number | null;
  shutter: string | null;
};

export type CameraResponse = {
  model: string | null;
  focalLengthMm: number | null;
  exposure: ExposureResponse;
};

export type DimensionsResponse = {
  width: number;
  height: number;
};

type MediaCommonResponse = {
  id: string;
  format: string;
  bytes: string;
  capturedAt: string | null;
  place: PlaceResponse | null;
  uploadedBy: string | null;
};

export type MediaResponse =
  | (MediaCommonResponse & {
      kind: "photo";
      dimensions: DimensionsResponse | null;
      duration: null;
      camera: CameraResponse | null;
    })
  | (MediaCommonResponse & {
      kind: "video";
      dimensions: DimensionsResponse | null;
      duration: number | null;
      camera: CameraResponse | null;
    })
  | (MediaCommonResponse & {
      kind: "audio";
      dimensions: null;
      duration: number | null;
      camera: null;
    });

export type AnalysisSegment = {
  secStart: number;
  secEnd: number;
  text: string;
};

export type AnalysisFrame = {
  second: number;
  text: string;
};

export type AnalysisResponse =
  | {
      description: string;
      score: number;
      transcription: AnalysisSegment[];
      frames: AnalysisFrame[];
    }
  | {
      description: string;
      score: number;
      transcription: AnalysisSegment[];
    }
  | {
      description: string;
      score: number;
    };

export type ItemResponse = {
  item: {
    id: string;
    projectId: string;
    mediaId: string;
    description: string | null;
    labelIds: string[];
    analysis: AnalysisResponse | null;
    createdAt: string;
  };
  media: MediaResponse;
  uploader: PublicUserResponse | null;
  links: {
    original: string | null;
    thumbnail: string | null;
    preview: string | null;
  };
};

export type GalleryPageResponse = CursorPageResponse<ItemResponse>;

export type DownloadLinkResponse = {
  itemId: string;
  url: string;
};

export type MediaDownloadResponse = {
  url: string;
};

export type DownloadLinksRequest = {
  itemIds: string[];
};

export type DownloadLinksResponse = {
  items: DownloadLinkResponse[];
};

export type MediaPatchRequest = {
  capturedAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type ItemDescriptionRequest = {
  description: string | null;
};
