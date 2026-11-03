import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { TransactionSql } from "postgres";
import { sql } from "../db.ts";
import { seenBy, uuidPattern } from "../memories/plugin.ts";
import { downloadTtlSeconds } from "./config.ts";
import { visibleLabelIds } from "./labels.ts";
import { abortUploads, deleteObjects, downloadUrl, storageConfigured } from "./r2.ts";
import type { MediaItem } from "./upload.ts";

type MediaKeys = {
  original_key: string;
  thumbnail_key: string | null;
  preview_key: string | null;
  status: MediaItem["status"];
  upload_id: string | null;
};

import type { Leftovers } from "../types/media.ts";

export type { Leftovers };
export async function removeMedia(
  tx: TransactionSql,
  memoryId: string,
  target:
    | {
        mediaId: string;
      }
    | {
        uploadedBy: string;
      }
    | "everything",
): Promise<Leftovers> {
  const mediaId = typeof target === "object" && "mediaId" in target ? target.mediaId : null;
  const uploadedBy =
    typeof target === "object" && "uploadedBy" in target ? target.uploadedBy : null;
  const gone = await tx<MediaKeys[]>`
    with gone as (
      delete from media_items
      where memory_id = ${memoryId}
        and (${mediaId}::uuid is null or id = ${mediaId}::uuid)
        and (${uploadedBy}::uuid is null or uploaded_by = ${uploadedBy}::uuid)
      returning *
    ),
    -- What the counters were ever told about. A record still in pending_upload
    -- moved nothing — the counters move when the upload completes — so taking
    -- it down here would push the tally below the truth.
    counted as (
      select * from gone where status <> 'pending_upload'
    ),
    memory as (
      update memories set
        storage_bytes = storage_bytes - coalesce((select sum(size_bytes) from counted), 0)::bigint,
        media_count = media_count - (select count(*) from counted)::int
      where id = ${memoryId} and exists (select 1 from counted)
    ),
    -- Grouped, because a set of rows may hold more than one person's material:
    -- the organizer deleting one file touches one row here, a departure touches
    -- one too, and nothing about this statement assumes either.
    tally as (
      update user_usage u set
        storage_bytes = u.storage_bytes - c.bytes,
        upload_count = u.upload_count - c.files,
        updated_at = now()
      from (
        select uploaded_by, sum(size_bytes)::bigint as bytes, count(*)::int as files
        from counted group by uploaded_by
      ) c
      where u.user_id = c.uploaded_by
    ),
    -- The worker must not be sent after material that is no longer there
    -- (architecture.md, «Участника исключили во время его загрузки»). Every job
    -- about these frames and not media_preview alone: a preview, a size, a
    -- screening and a question to the model are all queued off one upload, and
    -- one of them cancelled while the rest run would have the worker chasing a
    -- record nobody can see.
    queued as (
      delete from jobs where ref in (select id::text from gone)
    ),
    -- Что воркер про эти кадры записал: описание сцены и расшифровка речи. Обе
    -- таблицы — его (montage schema.sql), внешних ключей на media_items у них
    -- нет и быть не может (они заводятся в базе, где миграций api ещё не было),
    -- поэтому каскад их не заберёт — забирает тот, кто удаляет кадр.
    said as (
      delete from media_speech where media_id in (select id::text from gone)
    ),
    seen as (
      delete from media_understandings where media_id in (select id::text from gone)
    )
    select original_key, thumbnail_key, preview_key, status, upload_id from gone
  `;
  return {
    keys: gone
      .flatMap((row) => [row.original_key, row.thumbnail_key, row.preview_key])
      .filter((key): key is string => key !== null),
    uploads: gone.flatMap((row) =>
      row.status === "pending_upload" && row.upload_id !== null
        ? [{ key: row.original_key, uploadId: row.upload_id }]
        : [],
    ),
  };
}
export async function dropKeys(log: FastifyBaseLogger, left: Leftovers): Promise<void> {
  if (!storageConfigured()) return;
  const said = (error: unknown) =>
    log.warn({ err: error, ...left }, "media records are gone but their objects are not");
  if (left.uploads.length > 0) await abortUploads(left.uploads).catch(said);
  if (left.keys.length > 0) await deleteObjects(left.keys).catch(said);
}
export function galleryRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  app.get<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId/media",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!storageConfigured()) {
        return reply.code(503).send({ error: "storage not configured" });
      }
      type Row = MediaItem & {
        label_ids: string[];
        orientation: "landscape" | "portrait" | "square" | null;
      };
      const items = await sql<Row[]>`
        select mi.*, ${visibleLabelIds(request.membership.memory.id, request.user.id)} as label_ids,
          case when mi.width > mi.height then 'landscape'
               when mi.width < mi.height then 'portrait'
               when mi.width = mi.height then 'square' end as orientation
        from media_items mi
        where mi.memory_id = ${request.membership.memory.id} and mi.status <> 'pending_upload'
          and ${seenBy("mi", request.user.id)}
        order by coalesce(mi.captured_at, mi.created_at), mi.id
      `;
      const ttl = downloadTtlSeconds();
      return Promise.all(
        items.map(async (item) => ({
          id: item.id,
          kind: item.kind,
          status: item.status,
          uploaded_by: item.uploaded_by,
          size_bytes: item.size_bytes,
          captured_at: item.captured_at,
          width: item.width,
          height: item.height,
          orientation: item.orientation,
          duration_seconds: item.duration_seconds,
          created_at: item.created_at,
          hidden: item.hidden,
          label_ids: item.label_ids,
          thumbnail_url: item.thumbnail_key ? await downloadUrl(item.thumbnail_key, ttl) : null,
          preview_url: item.preview_key ? await downloadUrl(item.preview_key, ttl) : null,
          screening_rejected: item.screening_rejected,
          screening_reason: item.screening_reason,
        })),
      );
    },
  );
  app.get<{
    Params: {
      memoryId: string;
      mediaId: string;
    };
  }>(
    "/memories/:memoryId/media/:mediaId/download",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!storageConfigured()) {
        return reply.code(503).send({ error: "storage not configured" });
      }
      const { mediaId } = request.params;
      if (!uuidPattern.test(mediaId)) return reply.code(404).send(notFound);
      const [item] = await sql<Pick<MediaItem, "original_key">[]>`
        select original_key from media_items
        where id = ${mediaId} and memory_id = ${request.membership.memory.id}
          and status <> 'pending_upload' and ${seenBy("media_items", request.user.id)}
      `;
      if (!item) return reply.code(404).send(notFound);
      return { url: await downloadUrl(item.original_key, downloadTtlSeconds()) };
    },
  );
  app.get<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId/media/download",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!storageConfigured()) {
        return reply.code(503).send({ error: "storage not configured" });
      }
      const items = await sql<Pick<MediaItem, "id" | "kind" | "original_key">[]>`
        select id, kind, original_key from media_items
        where memory_id = ${request.membership.memory.id} and status <> 'pending_upload'
          and ${seenBy("media_items", request.user.id)}
        order by coalesce(captured_at, created_at), id
      `;
      const ttl = downloadTtlSeconds();
      return Promise.all(
        items.map(async (item) => ({
          id: item.id,
          kind: item.kind,
          url: await downloadUrl(item.original_key, ttl),
        })),
      );
    },
  );
  app.delete<{
    Params: {
      memoryId: string;
      mediaId: string;
    };
  }>(
    "/memories/:memoryId/media/:mediaId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const { mediaId } = request.params;
      if (!uuidPattern.test(mediaId)) return reply.code(404).send(notFound);
      const [item] = await sql<MediaItem[]>`
        select * from media_items where id = ${mediaId} and memory_id = ${memory.id}
      `;
      if (!item) return reply.code(404).send(notFound);
      if (item.uploaded_by !== request.user.id && role !== "organizer") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const left = await sql.begin((tx) => removeMedia(tx, memory.id, { mediaId: item.id }));
      await dropKeys(request.log, left);
      return { ok: true };
    },
  );
}
