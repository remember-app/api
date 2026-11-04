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
import { type Cursor, type CursorPage, cursorPage } from "../../pagination.ts";
import type { ProjectId, ProjectItemId, UploadId, UserId } from "../../types/id.ts";
import type {
  MediaAudioFormat,
  MediaItem,
  MediaKind,
  MediaPhotoFormat,
  MediaVideoFormat,
} from "../../types/mediaItem.ts";
import type { Upload, UploadStatus } from "../../types/upload.ts";
import { createMedia, type NewMedia } from "../media/media.ts";
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

const mimeOf = (format: string): string => {
  const types: Record<string, string> = {
    jpeg: "image/jpeg",
    png: "image/png",
    heic: "image/heic",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
  };
  return types[format] ?? "application/octet-stream";
};

const storageKeyOf = (format: string, id: UploadId): string => `remember/${format}/${id}`;

async function ownedUpload(
  id: UploadId,
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
  id: UploadId;
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
  const [open] = await sql<{ count: number }[]>`
    select count(*)::int as count from uploads
    where project_id = ${input.projectId} and status in ('pending', 'uploading')
  `;
  if ((await countItems(input.projectId)) + (open?.count ?? 0) >= config.media.projectMaxFiles()) {
    return { denial: "too_many_files" };
  }
  const id = randomUUID() as UploadId;
  const storageKey = storageKeyOf(format, id);
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
  const multipartId = await createUpload(storageKey, mimeOf(format));
  await sql`
    update uploads set multipart_id = ${multipartId}, status = 'uploading', updated_at = now()
    where id = ${id}
  `;
  const [row] = await sql<UploadRow[]>`select ${columns} from uploads where id = ${id}`;
  if (!row) throw new Error("upload insert returned no row");
  return { plan: await plan(row, multipartId) };
}

export async function resumeUpload(
  id: UploadId,
  projectId: ProjectId,
  userId: UserId,
): Promise<UploadPlan | undefined> {
  const row = await ownedUpload(id, projectId, userId);
  if (!row || row.status === "completed" || row.status === "failed") return undefined;
  const multipartId = row.multipartId ?? (await createUpload(row.storageKey, mimeOf(row.format)));
  if (!row.multipartId) {
    await sql`
      update uploads set multipart_id = ${multipartId}, status = 'uploading', updated_at = now()
      where id = ${id}
    `;
  }
  return plan(row, multipartId);
}

export type CompleteUpload = {
  id: UploadId;
  projectId: ProjectId;
  userId: UserId;
  parts: { part_number: number; etag: string }[];
};

export type CompleteResult =
  | { media: MediaItem; itemId: ProjectItemId }
  | { denial: "not_found" | "storage_error" | "too_large" };

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
    await markFailed(row.id, "limit_exceeded", "file exceeds the size limit");
    return { denial: "too_large" };
  }
  const newMedia: NewMedia =
    row.kind === "photo"
      ? {
          kind: "photo",
          storageKey: row.storageKey,
          uploadedBy: row.uploadedBy,
          format: photoFormats[row.format] as MediaPhotoFormat,
          bytes,
          dimensions: null,
          capturedAt: row.capturedAt,
          place: null,
          camera: null,
        }
      : row.kind === "video"
        ? {
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
          }
        : {
            kind: "audio",
            storageKey: row.storageKey,
            uploadedBy: row.uploadedBy,
            format: audioFormats[row.format] as MediaAudioFormat,
            bytes,
            duration: row.durationSeconds,
            capturedAt: row.capturedAt,
            place: null,
          };
  return sql.begin(async (tx) => {
    const media = await createMedia(newMedia, tx);
    await tx`
      update uploads
      set status = 'completed', error_code = null, error = null,
          media_id = ${media.id}, updated_at = now()
      where id = ${row.id}
    `;
    const itemId = await createItem(input.projectId, media.id, row.kind, tx);
    await enqueue("media_derive", row.id, tx);
    return { media, itemId };
  });
}

async function markFailed(id: UploadId, code: string, message: string | null): Promise<void> {
  await sql`
    update uploads
    set status = 'failed', error_code = ${code}, error = ${message}, updated_at = now()
    where id = ${id}
  `;
}

export type UploadView = {
  id: UploadId;
  uploadedBy: UserId;
  kind: MediaKind;
  fileName: string;
  declaredBytes: number;
  status: UploadStatus;
  createdAt: Date;
  errorCode: string | null;
  error: string | null;
  mediaId: string | null;
  deriveStatus: string | null;
  deriveError: string | null;
};

const viewColumns = sql`
  u.id,
  u.uploaded_by as "uploadedBy",
  u.kind,
  u.file_name as "fileName",
  u.declared_bytes as "declaredBytes",
  u.status,
  u.created_at as "createdAt",
  u.error_code as "errorCode",
  u.error,
  u.media_id as "mediaId",
  j.status as "deriveStatus",
  j.error as "deriveError"
`;

const afterClause = (after: Cursor | null) => sql`
  and (
    ${after?.at ?? null}::timestamptz is null
    or (date_trunc('milliseconds', u.created_at), u.id)
      < (${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid)
  )
`;

export async function listUploads(
  projectId: ProjectId,
  onlyUser: UserId | undefined,
  limit: number,
  after: Cursor | null,
): Promise<CursorPage<UploadView>> {
  const rows = onlyUser
    ? await sql<UploadView[]>`
        select ${viewColumns}
        from uploads u
        left join jobs j on j.kind = 'media_derive' and j.ref = u.id
        where u.project_id = ${projectId} and u.uploaded_by = ${onlyUser}
        ${afterClause(after)}
        order by date_trunc('milliseconds', u.created_at) desc, u.id desc
        limit ${limit + 1}
      `
    : await sql<UploadView[]>`
        select ${viewColumns}
        from uploads u
        left join jobs j on j.kind = 'media_derive' and j.ref = u.id
        where u.project_id = ${projectId}
        ${afterClause(after)}
        order by date_trunc('milliseconds', u.created_at) desc, u.id desc
        limit ${limit + 1}
      `;
  return cursorPage(rows, limit, (row) => ({ at: row.createdAt, id: row.id }));
}

export async function cancelUpload(
  id: UploadId,
  projectId: ProjectId,
  userId: UserId,
): Promise<boolean> {
  const row = await ownedUpload(id, projectId, userId);
  if (!row) return false;
  if (row.multipartId) await abortUploads([{ key: row.storageKey, uploadId: row.multipartId }]);
  await markFailed(id, "cancelled", "upload was cancelled");
  return true;
}

export type { Upload, UploadStatus };
