import type { MediaId, ProjectId, UserId } from "./id.ts";
import type { MediaKind } from "./mediaItem.ts";

export type Upload = {
  id: MediaId;
  projectId: ProjectId;
  uploadedBy: UserId;
  kind: MediaKind;
  storageKey: string;
  declaredBytes: number;
  status: UploadStatus;
};

export type UploadKind = Upload["kind"];

export type UploadStatus = "pending" | "uploading" | "completed" | "failed";
