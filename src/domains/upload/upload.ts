import { randomUUID } from "node:crypto";
import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import {
  abortUploads,
  completeUpload,
  createUpload,
  deleteObjects,
  headSize,
  partUrls,
  storageConfigured,
} from "../../integrations/storage/s3.ts";
import type { MediaId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type {
  MediaAudioFormat,
  MediaItem,
  MediaKind,
  MediaPhotoFormat,
  MediaVideoFormat,
} from "../../types/mediaItem.ts";
import type { Upload, UploadStatus } from "../../types/upload.ts";
import { createMedia } from "../media/media.ts";
import { countItems, createItem } from "../project/item.ts";
import { enqueue } from "../queue/queue.ts";

const columns = sql`
  id,
  project_id as "projectId",
  uploaded_by as "uploadedBy",
  kind,
  storage_key as "storageKey",
  declared_bytes as "declaredBytes",
  file_name as "fileName",
  format,
  captured_at as "capturedAt",
  duration_seconds as "durationSeconds",
  status,
  multipart_id as "multipartId"
`;

type UploadRow = Omit<Upload, "createdAt"> & {
  fileName: string;
  format: string;
  capturedAt: Date | null;
  durationSeconds: number | null;
  multipartId: string | null;
};

const photoFormats: Record<string, MediaPhotoFormat> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  heic: "heic",
  webp: "webp",
};

const videoFormats: Record<string, MediaVideoFormat> = {
  mp4: "mp4",
  mov: "mov",
};

const audioFormats: Record<string, MediaAudioFormat> = {
  mp3: "mp3",
  m4a: "m4a",
  wav: "wav",
};

const formatOf = (kind: MediaKind, fileName: string): string | undefined => {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (kind === "photo") return photoFormats[extension];
  if (kind === "video") return videoFormats[extension];
  return audioFormats[extension];
};

async function ownedUpload(
  id: MediaId,
  projectId: ProjectId,
  userId: UserId,
): Promise<UploadRow | undefined> {
  const [row] = await sql<UploadRow[]>`
    select ${columns}
    from uploads
    where id = ${id} and project_id = ${projectId} and uploaded_by = ${userId}
  `;
  return row;
}

export type UploadPlan = {
  id: MediaId;
  path: string;
  partBytes: number;
  parts: string[];
};

export type StartUpload = {
  projectId: ProjectId;
  userId: UserId;
  kind: MediaKind;
  sizeBytes: number;
  fileName: string;
  capturedAt: Date | null;
  durationSeconds: number | null;
};

export type StartResult =
  | { plan: UploadPlan }
  | { denial: "storage_unavailable" | "too_large" | "too_many_files" | "unsupported_format" };

async function plan(row: UploadRow, multipartId: string): Promise<UploadPlan> {
  const partBytes = config.media.partBytes();
  const count = Math.ceil(row.declaredBytes / partBytes);
  const parts = await partUrls(row.storageKey, multipartId, count, config.media.uploadTtlSeconds());
  return { id: row.id, path: row.storageKey, partBytes, parts };
}

export async function startUpload(input: StartUpload): Promise<StartResult> {
  if (!storageConfigured()) return { denial: "storage_unavailable" };
  if (input.sizeBytes > config.media.maxFileBytes()) return { denial: "too_large" };
  const format = formatOf(input.kind, input.fileName);
  if (!format) return { denial: "unsupported_format" };
  if ((await countItems(input.projectId)) >= config.media.projectMaxFiles()) {
    return { denial: "too_many_files" };
  }
  const id = randomUUID() as MediaId;
  const storageKey = `originals/${id}`;
  await sql`
    insert into uploads (
      id, project_id, uploaded_by, kind, storage_key, declared_bytes, file_name, format,
      captured_at, duration_seconds, status
    )
    values (
      ${id}, ${input.projectId}, ${input.userId}, ${input.kind}, ${storageKey},
      ${input.sizeBytes}, ${input.fileName}, ${format}, ${input.capturedAt},
      ${input.durationSeconds}, 'pending'
    )
  `;
  const multipartId = await createUpload(storageKey);
  await sql`
    update uploads set multipart_id = ${multipartId}, status = 'uploading', updated_at = now()
    where id = ${id}
  `;
  const [row] = await sql<UploadRow[]>`select ${columns} from uploads where id = ${id}`;
  if (!row) throw new Error("upload insert returned no row");
  return { plan: await plan(row, multipartId) };
}

export async function resumeUpload(
  id: MediaId,
  projectId: ProjectId,
  userId: UserId,
): Promise<UploadPlan | undefined> {
  const row = await ownedUpload(id, projectId, userId);
  if (!row || row.status === "completed" || row.status === "failed") return undefined;
  const multipartId = row.multipartId ?? (await createUpload(row.storageKey));
  if (!row.multipartId) {
    await sql`
      update uploads set multipart_id = ${multipartId}, status = 'uploading', updated_at = now()
      where id = ${id}
    `;
  }
  return plan(row, multipartId);
}

export type CompleteUpload = {
  id: MediaId;
  projectId: ProjectId;
  userId: UserId;
  parts: { part_number: number; etag: string }[];
};

export type CompleteResult =
  | { media: MediaItem; itemId: ProjectItemId }
  | { denial: "not_found" | "storage_error" | "too_large" | "unsupported_format" };

export async function completeMediaUpload(input: CompleteUpload): Promise<CompleteResult> {
  const row = await ownedUpload(input.id, input.projectId, input.userId);
  if (!row || row.status !== "uploading" || !row.multipartId) {
    return { denial: "not_found" };
  }
  await completeUpload(row.storageKey, row.multipartId, input.parts);
  const bytes = await headSize(row.storageKey);
  if (bytes === null) return { denial: "storage_error" };
  if (bytes > config.media.maxFileBytes()) {
    await deleteObjects([row.storageKey]);
    await sql`update uploads set status = 'failed', updated_at = now() where id = ${row.id}`;
    return { denial: "too_large" };
  }
  const media =
    row.kind === "photo"
      ? await createMedia({
          kind: "photo",
          storageKey: row.storageKey,
          uploadedBy: row.uploadedBy,
          format: photoFormats[row.format] as MediaPhotoFormat,
          bytes,
          dimensions: null,
          capturedAt: row.capturedAt,
          place: null,
          camera: null,
        })
      : row.kind === "video"
        ? await createMedia({
            kind: "video",
            storageKey: row.storageKey,
            uploadedBy: row.uploadedBy,
            format: videoFormats[row.format] as MediaVideoFormat,
            bytes,
            dimensions: null,
            duration: row.durationSeconds,
            capturedAt: row.capturedAt,
            place: null,
            camera: null,
          })
        : await createMedia({
            kind: "audio",
            storageKey: row.storageKey,
            uploadedBy: row.uploadedBy,
            format: audioFormats[row.format] as MediaAudioFormat,
            bytes,
            duration: row.durationSeconds,
            capturedAt: row.capturedAt,
            place: null,
          });
  await sql`update uploads set status = 'completed', updated_at = now() where id = ${row.id}`;
  const itemId = await createItem(input.projectId, media.id, row.kind);
  await enqueue("media_derive", media.id);
  return { media, itemId };
}

export async function cancelUpload(
  id: MediaId,
  projectId: ProjectId,
  userId: UserId,
): Promise<boolean> {
  const row = await ownedUpload(id, projectId, userId);
  if (!row) return false;
  if (row.multipartId) await abortUploads([{ key: row.storageKey, uploadId: row.multipartId }]);
  await sql`
    update uploads set status = 'failed', updated_at = now() where id = ${id}
  `;
  return true;
}

export type { Upload, UploadStatus };
