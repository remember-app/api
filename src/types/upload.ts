import type { ProjectId, UploadId, UserId } from "./id.ts";
import type { MediaKind } from "./mediaItem.ts";

export type Upload = {
  id: UploadId;
  projectId: ProjectId | null;
  uploadedBy: UserId;
  kind: MediaKind;
  storageKey: string;
  status: UploadStatus;
  file: UploadFile;
  failure: UploadFailure | null;
};

export type UploadFile = {
  name: string;
  format: string;
  bytes: number;
};

export type UploadFailure = {
  code: string | null;
  message: string | null;
};

export type UploadKind = Upload["kind"];

export type UploadStatus = "pending" | "uploading" | "completed" | "failed";
