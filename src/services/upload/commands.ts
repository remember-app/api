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
import type { ProjectId, ProjectItemId, UploadId, UserId } from "../../types/id.ts";
import type { MediaFormat, MediaItem, MediaKind } from "../../types/mediaItem.ts";
import type { Upload } from "../../types/upload.ts";
import { StorageFullError, spendProjectStorage, spendUserStorage } from "../consumable/commands.ts";
import { createMedia } from "../media/commands.ts";
import { accessOf, canContribute } from "../project/access.ts";
import { createItem } from "../project/item/commands.ts";
import { countItems } from "../project/item/queries.ts";
import { enqueue } from "../queue/commands.ts";

const columns = sql`
  id,
  project_id as "projectId",
  uploaded_by as "uploadedBy",
  kind,
  storage_key as "storageKey",
  status,
  file,
  failure,
  multipart_id as "multipartId"
`;

type UploadRow = Omit<Upload, "createdAt"> & { multipartId: string | null };

const photoFormats: Record<string, MediaFormat> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  heic: "heic",
  webp: "webp",
};

const videoFormats: Record<string, MediaFormat> = {
  mp4: "mp4",
  mov: "mov",
};

const audioFormats: Record<string, MediaFormat> = {
  mp3: "mp3",
  m4a: "m4a",
  wav: "wav",
};

const formatOf = (kind: MediaKind, fileName: string): MediaFormat | undefined => {
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
  projectId: ProjectId | null,
  userId: UserId,
): Promise<UploadRow | undefined> {
  const [row] = await sql<UploadRow[]>`
    select ${columns}
    from uploads
    where id = ${id} and project_id is not distinct from ${projectId} and uploaded_by = ${userId}
  `;
  return row;
}

async function mayUpload(
  projectId: ProjectId | null,
  userId: UserId,
): Promise<"ok" | "not_found" | "forbidden"> {
  if (projectId === null) return "ok";
  const access = await accessOf(projectId, userId);
  if (!access) return "not_found";
  if (!canContribute(access)) return "forbidden";
  return "ok";
}

export type UploadPlan = {
  id: UploadId;
  path: string;
  partBytes: number;
  parts: string[];
};

export type StartUpload = {
  projectId: ProjectId | null;
  userId: UserId;
  kind: MediaKind;
  sizeBytes: number;
  fileName: string;
  /** Дата съёмки, как её знает устройство: ею кадр живёт, пока файл не расскажет свою. */
  capturedAt?: string | null;
};

export type StartResult =
  | { plan: UploadPlan }
  | {
      denial:
        | "not_found"
        | "forbidden"
        | "storage_unavailable"
        | "too_large"
        | "too_many_files"
        | "insufficient_storage"
        | "unsupported_format";
    };

async function plan(row: UploadRow, multipartId: string): Promise<UploadPlan> {
  const partBytes = config.media.partBytes();
  const count = Math.ceil(row.file.bytes / partBytes);
  const parts = await partUrls(row.storageKey, multipartId, count, config.media.uploadTtlSeconds());
  return { id: row.id, path: row.storageKey, partBytes, parts };
}

export async function startUpload(input: StartUpload): Promise<StartResult> {
  const allowed = await mayUpload(input.projectId, input.userId);
  if (allowed !== "ok") return { denial: allowed };
  if (!storageConfigured()) return { denial: "storage_unavailable" };
  if (input.sizeBytes > config.media.maxFileBytes()) return { denial: "too_large" };
  const format = formatOf(input.kind, input.fileName);
  if (!format) return { denial: "unsupported_format" };
  if (input.projectId !== null) {
    const [open] = await sql<{ count: number }[]>`
      select count(*)::int as count from uploads
      where project_id = ${input.projectId} and status in ('pending', 'uploading')
    `;
    if (
      (await countItems(input.projectId)) + (open?.count ?? 0) >=
      config.media.projectMaxFiles()
    ) {
      return { denial: "too_many_files" };
    }
    const [space] = await sql<{ available: string }[]>`
      select storage_bytes - storage_spend as available from projects where id = ${input.projectId}
    `;
    if (!space || Number(space.available) < input.sizeBytes) {
      return { denial: "insufficient_storage" };
    }
  } else {
    const [space] = await sql<{ available: string }[]>`
      select storage_bytes - storage_spend as available from users where id = ${input.userId}
    `;
    if (!space || Number(space.available) < input.sizeBytes) {
      return { denial: "insufficient_storage" };
    }
  }
  const id = randomUUID() as UploadId;
  const storageKey = storageKeyOf(format, id);
  await sql`
    insert into uploads (id, project_id, uploaded_by, kind, storage_key, status, file)
    values (
      ${id}, ${input.projectId}, ${input.userId}, ${input.kind}, ${storageKey}, 'pending',
      ${sql.json({
        name: input.fileName,
        format,
        bytes: input.sizeBytes,
        capturedAt: input.capturedAt ?? null,
      })}
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
  projectId: ProjectId | null,
  userId: UserId,
): Promise<UploadPlan | undefined> {
  const allowed = await mayUpload(projectId, userId);
  if (allowed !== "ok") return undefined;
  const row = await ownedUpload(id, projectId, userId);
  if (!row || row.status === "completed" || row.status === "failed") return undefined;
  const multipartId =
    row.multipartId ?? (await createUpload(row.storageKey, mimeOf(row.file.format)));
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
  projectId: ProjectId | null;
  userId: UserId;
  parts: { part_number: number; etag: string }[];
};

export type CompleteResult =
  | { media: MediaItem; itemId: ProjectItemId | null }
  | {
      denial: "not_found" | "forbidden" | "storage_error" | "too_large" | "insufficient_storage";
    };

export async function completeMediaUpload(input: CompleteUpload): Promise<CompleteResult> {
  const allowed = await mayUpload(input.projectId, input.userId);
  if (allowed !== "ok") return { denial: allowed };
  const row = await ownedUpload(input.id, input.projectId, input.userId);
  if (!row || row.status !== "uploading" || !row.multipartId) {
    return { denial: "not_found" };
  }
  await completeUpload(row.storageKey, row.multipartId, input.parts);
  const bytes = await headSize(row.storageKey);
  if (bytes === null) return { denial: "storage_error" };
  if (bytes > config.media.maxFileBytes()) {
    await deleteObjects([row.storageKey]);
    await markFailed(row.id, "capacity_exceeded", "file exceeds the maximum size");
    return { denial: "too_large" };
  }
  try {
    return await sql.begin(async (tx) => {
      const captured = row.file.capturedAt ? Date.parse(row.file.capturedAt) : Number.NaN;
      const media = await createMedia(
        {
          kind: row.kind,
          storageKey: row.storageKey,
          fingerprint: "",
          format: row.file.format as MediaFormat,
          bytes,
          meta: {
            dimensions: null,
            duration: null,
            at: Number.isNaN(captured) ? null : new Date(captured),
            place: null,
            camera: null,
          },
        },
        tx,
      );
      await tx`
        update uploads
        set status = 'completed', failure = null, media_id = ${media.id}, updated_at = now()
        where id = ${row.id}
      `;
      let itemId: ProjectItemId | null = null;
      if (row.projectId === null) {
        const spent = await spendUserStorage(tx, input.userId, bytes);
        if (!spent) throw new StorageFullError();
      } else {
        itemId = await createItem(row.projectId, media.id, row.kind, row.uploadedBy, tx);
        const spent = await spendProjectStorage(tx, row.projectId, input.userId, bytes);
        if (!spent) throw new StorageFullError();
      }
      await enqueue("media_derive", row.id, tx);
      return { media, itemId };
    });
  } catch (error) {
    if (error instanceof StorageFullError) {
      await deleteObjects([row.storageKey]);
      await markFailed(row.id, "capacity_exceeded", "project storage is exhausted");
      return { denial: "insufficient_storage" };
    }
    throw error;
  }
}

async function markFailed(id: UploadId, code: string, message: string | null): Promise<void> {
  await sql`
    update uploads
    set status = 'failed', failure = ${sql.json({ code, message })}, updated_at = now()
    where id = ${id}
  `;
}

export async function cancelUpload(
  id: UploadId,
  projectId: ProjectId | null,
  userId: UserId,
  purge = false,
): Promise<"ok" | "not_found" | "forbidden"> {
  const allowed = await mayUpload(projectId, userId);
  if (allowed !== "ok") return allowed;
  const row = await ownedUpload(id, projectId, userId);
  if (!row) return "not_found";
  if (row.multipartId) await abortUploads([{ key: row.storageKey, uploadId: row.multipartId }]);
  if (purge) {
    await sql`delete from uploads where id = ${id}`;
  } else {
    await markFailed(id, "cancelled", "upload was cancelled");
  }
  return "ok";
}
