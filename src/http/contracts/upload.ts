import type { CursorPageResponse } from "./common.ts";
import type { MediaKind } from "./media.ts";
import type { PublicUserResponse } from "./user.ts";

export type UploadStatus = "pending" | "uploading" | "completed" | "failed";

export type DeriveStatus = "queued" | "running" | "done" | "failed";

export type UploadResponse = {
  id: string;
  projectId: string;
  kind: MediaKind;
  fileName: string;
  declaredBytes: string;
  status: UploadStatus;
  derive: DeriveStatus | null;
  errorCode: string | null;
  error: string | null;
  mediaId: string | null;
  uploader: PublicUserResponse | null;
  createdAt: string;
};

export type UploadsPageResponse = CursorPageResponse<UploadResponse>;

export type StartUploadRequest = {
  kind: MediaKind;
  sizeBytes: number;
  fileName: string;
  capturedAt?: string | null;
  durationSeconds?: number | null;
  fingerprint?: string | null;
};

export type CompleteUploadRequest = {
  parts: {
    part_number: number;
    etag: string;
  }[];
};

export type UploadPlanResponse = {
  id: string;
  path: string;
  partBytes: number;
  parts: string[];
};

export type UploadCompleteResponse = {
  mediaId: string;
  itemId: string;
  status: "processing";
};
