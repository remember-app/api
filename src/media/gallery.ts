import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { TransactionSql } from "postgres";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { downloadTtlSeconds } from "./config.ts";
import { deleteObjects, downloadUrl, storageConfigured } from "./r2.ts";
import type { MediaItem } from "./upload.ts";

/**
 * What becomes of material once it is in: the gallery every member looks at,
 * and the two ways a record leaves — deleted one at a time, or carried out by
 * the person who brought it (architecture.md, «Выход / исключение участника»).
 *
 * Both ways go through `removeMedia`, which is the point of it: the counters,
 * the per-user tally and the queued previews are settled in one statement, so
 * there is no second copy of that arithmetic to drift out of step with this one.
 */

/** The three keys a record can point at; only the original always exists. */
type MediaKeys = {
  original_key: string;
  thumbnail_key: string | null;
  preview_key: string | null;
};

/**
 * Takes media out of a memory for good — the rows, the memory's counters, the
 * uploaders' tallies and the `media_preview` jobs queued for them. Answers with
 * the R2 keys the rows pointed at; the caller drops those *after* the
 * transaction commits (`dropKeys`).
 *
 * Exactly one of `mediaId` and `uploadedBy` is given: one record deleted by its
 * uploader or the organizer, or everything one person brought when they leave.
 * Both filters ride in the same statement rather than in two, so that nothing
 * can be inserted between choosing the rows and counting them — a file that
 * finished uploading while its owner was being excluded would otherwise be left
 * behind with nobody in the memory who could delete it.
 *
 * Runs inside the caller's transaction and never opens one of its own: the
 * departure case must commit together with the membership row it belongs to.
 */
export async function removeMedia(
  tx: TransactionSql,
  memoryId: string,
  target: { mediaId: string } | { uploadedBy: string },
): Promise<string[]> {
  const mediaId = "mediaId" in target ? target.mediaId : null;
  const uploadedBy = "uploadedBy" in target ? target.uploadedBy : null;

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
    -- (architecture.md, «Участника исключили во время его загрузки»). The jobs
    -- table belongs to montage; this and the insert in upload.ts are the only
    -- two statements api runs against it.
    queued as (
      delete from jobs where type = 'media_preview' and ref in (select id::text from gone)
    )
    select original_key, thumbnail_key, preview_key from gone
  `;

  return gone
    .flatMap((row) => [row.original_key, row.thumbnail_key, row.preview_key])
    .filter((key): key is string => key !== null);
}

/**
 * The bytes, once the rows that pointed at them are committed. Outside the
 * transaction on purpose: R2 has no rollback, and a delete that went through
 * there while the database rolled back would leave rows pointing at nothing.
 * The other way round leaves objects nobody references, which costs storage
 * and nothing else.
 *
 * Best effort for the same reason — the record is already gone, and answering
 * the caller with a failure would tell them the deletion did not happen when
 * it did. What is left behind goes in the log instead.
 */
export async function dropKeys(log: FastifyBaseLogger, keys: string[]): Promise<void> {
  if (keys.length === 0 || !storageConfigured()) return;
  try {
    await deleteObjects(keys);
  } catch (error) {
    log.warn({ err: error, keys }, "media records are gone but their objects are not");
  }
}

/**
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check these routes hang on.
 */
export function galleryRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };

  // The gallery. Every member reads it, `viewer` included: the matrix gives
  // them «смотреть галерею», and a non-member never reaches this line — the
  // membership check answered them 404.
  app.get<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/media",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      // The signed links *are* the answer here, so a bucket that is not
      // configured is not something to paper over with a list of nulls.
      if (!storageConfigured()) {
        return reply.code(503).send({ error: "storage not configured" });
      }

      // `pending_upload` is left out: those are uploads in flight, with no
      // bytes in the store to show. Everything else belongs here, `failed`
      // included — the client draws a placeholder and offers a retry
      // (architecture.md, «Обработка ошибок»).
      //
      // Ordered as the montage orders its material: by when it was shot,
      // falling back to when it arrived for a file that carries no date
      // (architecture.md, «Montage-пайплайн»). One rule for both, so the
      // gallery reads in the order the ролик plays.
      const items = await sql<MediaItem[]>`
        select * from media_items
        where memory_id = ${request.membership.memory.id} and status <> 'pending_upload'
        order by coalesce(captured_at, created_at), id
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
          duration_seconds: item.duration_seconds,
          created_at: item.created_at,
          // Derivatives only. The original is deliberately not linked from
          // here — the gallery shows the light version, and «скачать оригинал»
          // is m-6 (architecture.md, «Хранилище и медиа-пайплайн»). Null until
          // the worker has made them.
          thumbnail_url: item.thumbnail_key ? await downloadUrl(item.thumbnail_key, ttl) : null,
          preview_url: item.preview_key ? await downloadUrl(item.preview_key, ttl) : null,
        })),
      );
    },
  );

  // Whoever brought it, and the organizer. The first is ownership and not role
  // (architecture.md: «Своё загруженное медиа может удалить каждый»), which is
  // why a `viewer` may delete their own file and a `contributor` may not delete
  // a neighbour's.
  app.delete<{ Params: { memoryId: string; mediaId: string } }>(
    "/memories/:memoryId/media/:mediaId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const { mediaId } = request.params;
      // «Not a uuid» is «no such record», not a 400 — the house rule of this
      // route family (README, «404 один на всех»). Not in a params schema for
      // the reason the member route gives: schema validation runs before the
      // preHandlers and would answer 400 from outside the memory.
      if (!uuidPattern.test(mediaId)) return reply.code(404).send(notFound);

      const [item] = await sql<MediaItem[]>`
        select * from media_items where id = ${mediaId} and memory_id = ${memory.id}
      `;
      // A record of another memory is «no such record» here, for the same
      // reason another memory is «no such memory».
      if (!item) return reply.code(404).send(notFound);
      if (item.uploaded_by !== request.user.id && role !== "organizer") {
        return reply.code(403).send({ error: "forbidden" });
      }

      // Deleted by id and not by the row already read: two callers racing must
      // move the counters once, and whoever the delete returns a row to is the
      // one who moves them.
      const keys = await sql.begin((tx) => removeMedia(tx, memory.id, { mediaId: item.id }));
      await dropKeys(request.log, keys);
      return { ok: true };
    },
  );
}
