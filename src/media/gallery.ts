import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { TransactionSql } from "postgres";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { downloadTtlSeconds } from "./config.ts";
import { visibleLabelIds } from "./labels.ts";
import { abortUploads, deleteObjects, downloadUrl, storageConfigured } from "./r2.ts";
import type { MediaItem } from "./upload.ts";

/**
 * What becomes of material once it is in: the gallery every member looks at,
 * and the three ways a record leaves — deleted one at a time, carried out by
 * the person who brought it (architecture.md, «Выход / исключение участника»),
 * or taken down with the memory itself (doc-01).
 *
 * All three go through `removeMedia`, which is the point of it: the counters,
 * the per-user tally and the queued jobs are settled in one statement, so
 * there is no second copy of that arithmetic to drift out of step with this one.
 */

/** The three keys a record can point at; only the original always exists. */
type MediaKeys = {
  original_key: string;
  thumbnail_key: string | null;
  preview_key: string | null;
  status: MediaItem["status"];
  upload_id: string | null;
};

/**
 * What a removal leaves behind in R2: objects that were assembled, and uploads
 * that never were. The two are freed differently — a `DELETE` on the key leaves
 * a multipart in progress untouched — which is why they are counted apart.
 */
export type Leftovers = { keys: string[]; uploads: { key: string; uploadId: string }[] };

/**
 * Takes media out of a memory for good — the rows, the memory's counters, the
 * uploaders' tallies, the jobs queued about it and everything the worker wrote
 * down about each frame. Answers with the R2 keys the rows pointed at; the
 * caller drops those *after* the transaction commits (`dropKeys`).
 *
 * `target` names one record deleted by its uploader or the organizer, or
 * everything one person brought when they leave, or — spelled out, never by
 * omission — the whole memory's material, which is what deleting the memory
 * itself takes with it.
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
  target: { mediaId: string } | { uploadedBy: string } | "everything",
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
    // Only the records still in `pending_upload` — past that the upload was
    // sealed into an object and the id names nothing. This row is the only
    // place that id was ever written down, so an upload left un-aborted here
    // is one the hourly sweep will never see either: it works off `media_items`
    // rows, and this one is on its way out.
    uploads: gone.flatMap((row) =>
      row.status === "pending_upload" && row.upload_id !== null
        ? [{ key: row.original_key, uploadId: row.upload_id }]
        : [],
    ),
  };
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
export async function dropKeys(log: FastifyBaseLogger, left: Leftovers): Promise<void> {
  if (!storageConfigured()) return;
  const said = (error: unknown) =>
    log.warn({ err: error, ...left }, "media records are gone but their objects are not");
  // The aborts first: a `DELETE` on a key that a multipart is still writing to
  // leaves the parts behind. First, but never instead of — each half answers
  // for itself, or one upload the bucket refuses to release would keep every
  // object of a deleted memory in it.
  if (left.uploads.length > 0) await abortUploads(left.uploads).catch(said);
  if (left.keys.length > 0) await deleteObjects(left.keys).catch(said);
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
      //
      // `label_ids` едет тем же запросом: лейблы — свойство кадра, и отдельный
      // маршрут за ними был бы вторым обходом той же галереи. Подзапросом, а не
      // join'ом — кадр, лежащий в трёх лейблах, приходит один раз, и состав с
      // порядком списка от лейблов не зависят вовсе (src/media/labels.ts).
      const items = await sql<(MediaItem & { label_ids: string[] })[]>`
        select mi.*, ${visibleLabelIds(request.membership.memory.id, request.user.id)} as label_ids
        from media_items mi
        where mi.memory_id = ${request.membership.memory.id} and mi.status <> 'pending_upload'
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
          duration_seconds: item.duration_seconds,
          created_at: item.created_at,
          // В каких лейблах этот кадр лежит — и только в тех, что видны
          // спрашивающему. Чужой личный лейбл не оставляет здесь следа: ни id,
          // ни лишней длины массива. Галерея приходит без параметров и
          // фильтруется на телефоне, поэтому кадр несёт свои лейблы с собой, а
          // не отбирается по ним на сервере (doc-13).
          label_ids: item.label_ids,
          // Derivatives only. The original is deliberately not linked from
          // here — the gallery shows the light version, and the original goes
          // out only when somebody asks for it, through the two `/download`
          // routes below (architecture.md, «Хранилище и медиа-пайплайн»). Null
          // until the worker has made them.
          thumbnail_url: item.thumbnail_key ? await downloadUrl(item.thumbnail_key, ttl) : null,
          preview_url: item.preview_key ? await downloadUrl(item.preview_key, ttl) : null,
          // The automatic screening, handed over as the worker left it (doc-03):
          // a proposal the organizer corrects before ordering a montage, not a
          // decision. Null until the analysis has looked — the same «ещё не
          // готово» as the two links above, and deliberately not `false`, which
          // would read as «looked at and kept».
          screening_rejected: item.screening_rejected,
          screening_reason: item.screening_reason,
        })),
      );
    },
  );

  // «Скачать» — the one place the original itself is handed out. Every member
  // may, `viewer` included: the matrix gives them «скачивать оригиналы», and
  // the link is the file, so there is nothing further to check beyond standing
  // in the memory (architecture.md, «Проверка прав»).
  //
  // Note the two routes are one path apart — `/media/download` and
  // `/media/:mediaId/download`. The router prefers the literal segment, so the
  // whole-gallery route is never read as a record whose id is «download».
  app.get<{ Params: { memoryId: string; mediaId: string } }>(
    "/memories/:memoryId/media/:mediaId/download",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!storageConfigured()) {
        return reply.code(503).send({ error: "storage not configured" });
      }
      const { mediaId } = request.params;
      // Not a uuid is «no such record», as everywhere in this family (docs/auth.md,
      // «404 один на всех»), and for the reason the delete route gives: a
      // params schema would answer before the membership check had run.
      if (!uuidPattern.test(mediaId)) return reply.code(404).send(notFound);

      // `pending_upload` is filtered here rather than answered separately: the
      // bytes are not in the store yet, so a link to them would sign nothing —
      // which, to the caller, is exactly «no such record».
      const [item] = await sql<Pick<MediaItem, "original_key">[]>`
        select original_key from media_items
        where id = ${mediaId} and memory_id = ${request.membership.memory.id}
          and status <> 'pending_upload'
      `;
      if (!item) return reply.code(404).send(notFound);

      return { url: await downloadUrl(item.original_key, downloadTtlSeconds()) };
    },
  );

  // «Скачать всю галерею» in one answer: the client saves the files itself, and
  // asking for a link per file would be a round trip per file. Ordered as the
  // gallery is, so what arrives on the phone lines up with what was on screen.
  app.get<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/media/download",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!storageConfigured()) {
        return reply.code(503).send({ error: "storage not configured" });
      }

      const items = await sql<Pick<MediaItem, "id" | "kind" | "original_key">[]>`
        select id, kind, original_key from media_items
        where memory_id = ${request.membership.memory.id} and status <> 'pending_upload'
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
      // route family (docs/auth.md, «404 один на всех»). Not in a params schema for
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
      const left = await sql.begin((tx) => removeMedia(tx, memory.id, { mediaId: item.id }));
      await dropKeys(request.log, left);
      return { ok: true };
    },
  );
}
