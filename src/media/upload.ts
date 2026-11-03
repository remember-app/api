import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";
import {
  maxFileBytes,
  maxVideoSeconds,
  memoryMaxBytes,
  memoryMaxFiles,
  partBytes,
  uploadTtlSeconds,
} from "./config.ts";
import { dropKeys } from "./gallery.ts";
import {
  completeUpload,
  createUpload,
  headSize,
  partUrls,
  storageConfigured,
  type UploadedPart,
} from "./r2.ts";


const intentBody = {
  type: "object",
  required: ["kind", "size_bytes"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["photo", "video"] },
    size_bytes: { type: "integer", minimum: 1 },
    captured_at: { type: ["string", "null"], format: "date-time" },
    duration_seconds: { type: ["number", "null"], minimum: 0 },
    file_name: { type: ["string", "null"], maxLength: 255 },
  },
} as const;
export const completeBody = {
  type: "object",
  required: ["parts"],
  additionalProperties: false,
  properties: {
    parts: {
      type: "array",
      minItems: 1,
      maxItems: 10000,
      items: {
        type: "object",
        required: ["part_number", "etag"],
        additionalProperties: false,
        properties: {
          part_number: { type: "integer", minimum: 1, maximum: 10000 },
          etag: {
            type: "string",
            pattern: '^"?[A-Za-z0-9]{1,64}(-[0-9]{1,5})?"?$',
            maxLength: 200,
          },
        },
      },
    },
  },
} as const;
export const partCount = (sizeBytes: number) => Math.max(1, Math.ceil(sizeBytes / partBytes()));
async function ensureUpload(item: MediaItem): Promise<string> {
  if (item.upload_id) return item.upload_id;
  const uploadId = await createUpload(item.original_key);
  await sql`
    update media_items set upload_id = ${uploadId}, updated_at = now() where id = ${item.id}
  `;
  return uploadId;
}
async function uploadPlan(item: MediaItem) {
  const uploadId = await ensureUpload(item);
  const ttl = uploadTtlSeconds();
  const size = Number(item.size_bytes);
  return {
    id: item.id,
    status: item.status,
    upload: {
      key: item.original_key,
      upload_id: uploadId,
      part_size: partBytes(),
      parts: (await partUrls(item.original_key, uploadId, partCount(size), ttl)).map(
        (url, index) => ({ part_number: index + 1, url }),
      ),
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    },
  };
}
export function uploadRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const unconfigured = { error: "storage not configured" };
  async function ownItem(memoryId: string, userId: string, mediaId: string) {
    if (!uuidPattern.test(mediaId)) return undefined;
    const [item] = await sql<MediaItem[]>`
      select * from media_items
      where id = ${mediaId} and memory_id = ${memoryId} and uploaded_by = ${userId}
    `;
    return item;
  }
  app.post<{
    Params: {
      memoryId: string;
    };
    Body: {
      kind: "photo" | "video";
      size_bytes: number;
      captured_at?: string | null;
      duration_seconds?: number | null;
      file_name?: string | null;
    };
  }>(
    "/memories/:memoryId/media",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: intentBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role === "viewer") return reply.code(403).send({ error: "forbidden" });
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const { kind, size_bytes, captured_at } = request.body;
      const duration = request.body.duration_seconds ?? null;
      if (kind === "video" && duration === null) {
        return reply.code(400).send({ error: "duration_seconds is required for a video" });
      }
      if (size_bytes > maxFileBytes()) {
        return reply.code(413).send({ error: "file is too large", limit_bytes: maxFileBytes() });
      }
      if (kind === "video" && duration !== null && duration > maxVideoSeconds()) {
        return reply
          .code(413)
          .send({ error: "video is too long", limit_seconds: maxVideoSeconds() });
      }
      if (memory.media_count >= memoryMaxFiles()) {
        return reply.code(409).send({ error: "memory is full", limit_files: memoryMaxFiles() });
      }
      if (BigInt(memory.storage_bytes) + BigInt(size_bytes) > BigInt(memoryMaxBytes())) {
        return reply
          .code(409)
          .send({ error: "memory is out of space", limit_bytes: memoryMaxBytes() });
      }
      const fileName = request.body.file_name?.replaceAll("\u0000", "").trim() || null;
      const id = randomUUID();
      const [item] = await sql<MediaItem[]>`
        insert into media_items
          (id, memory_id, uploaded_by, kind, original_key, size_bytes, captured_at,
           duration_seconds, file_name)
        values (${id}, ${memory.id}, ${request.user.id}, ${kind}, ${`originals/${id}`},
                ${size_bytes}, ${captured_at ?? null}, ${kind === "video" ? duration : null},
                ${fileName})
        returning *
      `;
      if (!item) throw new Error("insert into media_items returned no row");
      return reply.code(201).send(await uploadPlan(item));
    },
  );
  app.get<{
    Params: {
      memoryId: string;
      mediaId: string;
    };
  }>(
    "/memories/:memoryId/media/:mediaId/upload",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const item = await ownItem(
        request.membership.memory.id,
        request.user.id,
        request.params.mediaId,
      );
      if (!item) return reply.code(404).send(notFound);
      if (item.status !== "pending_upload") {
        return reply.code(409).send({ error: "upload is already finished", status: item.status });
      }
      return uploadPlan(item);
    },
  );
  app.post<{
    Params: {
      memoryId: string;
      mediaId: string;
    };
    Body: {
      parts: UploadedPart[];
    };
  }>(
    "/memories/:memoryId/media/:mediaId/complete",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: completeBody } },
    async (request, reply) => {
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const { memory } = request.membership;
      const item = await ownItem(memory.id, request.user.id, request.params.mediaId);
      if (!item) return reply.code(404).send(notFound);
      if (item.status !== "pending_upload") {
        return { id: item.id, status: item.status, first_upload: false };
      }
      if (!item.upload_id) return reply.code(409).send({ error: "upload was never started" });
      try {
        await completeUpload(item.original_key, item.upload_id, request.body.parts);
      } catch (error) {
        request.log.warn({ err: error, media: item.id }, "completing the upload failed");
      }
      const size = await headSize(item.original_key);
      if (size === null) {
        return reply.code(409).send({ error: "the upload is not in storage" });
      }
      const overSized = size > maxFileBytes();
      const overMemory = BigInt(memory.storage_bytes) + BigInt(size) > BigInt(memoryMaxBytes());
      if (overSized || overMemory) {
        await sql`delete from media_items where id = ${item.id} and status = 'pending_upload'`;
        await dropKeys(request.log, { keys: [item.original_key], uploads: [] });
        request.log.warn(
          { media: item.id, declared: item.size_bytes, measured: size },
          "an upload arrived larger than it was declared and was refused",
        );
        return overSized
          ? reply.code(413).send({ error: "file is too large", limit_bytes: maxFileBytes() })
          : reply
              .code(409)
              .send({ error: "memory is out of space", limit_bytes: memoryMaxBytes() });
      }
      const firstUpload = await sql.begin(async (tx) => {
        const [claimed] = await tx`
          update media_items
          set status = 'processing', size_bytes = ${size}, updated_at = now()
          where id = ${item.id} and status = 'pending_upload'
          returning id
        `;
        if (!claimed) return false;
        await tx`
          update memories
          set storage_bytes = storage_bytes + ${size}, media_count = media_count + 1
          where id = ${memory.id}
        `;
        await tx`
          insert into user_usage (user_id, storage_bytes, upload_count)
          values (${item.uploaded_by}, ${size}, 1)
          on conflict (user_id) do update set
            storage_bytes = user_usage.storage_bytes + excluded.storage_bytes,
            upload_count = user_usage.upload_count + 1,
            updated_at = now()
        `;
        await tx`insert into jobs (type, ref) values ('media_preview', ${item.id})`;
        if (request.membership.status === "more_coming") return false;
        if (request.membership.status === "done") return false;
        const moved = await tx`
          update memory_members set status = 'more_coming'
          where memory_id = ${memory.id} and user_id = ${request.user.id}
            and status in ('not_started', 'nothing')
          returning user_id
        `;
        return moved.length > 0 && request.membership.status === "not_started";
      });
      const [current] = await sql<
        {
          id: string;
          status: string;
        }[]
      >`
        select id, status from media_items where id = ${item.id}
      `;
      if (!current) return reply.code(404).send(notFound);
      return { ...current, first_upload: firstUpload };
    },
  );
}
