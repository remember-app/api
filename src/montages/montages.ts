import type { FastifyInstance } from "fastify";
import type { TransactionSql } from "postgres";
import { sql } from "../db.ts";
import { downloadTtlSeconds } from "../media/config.ts";
import { dropKeys } from "../media/gallery.ts";
import { storageConfigured } from "../media/r2.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { stagesFor } from "./journal.ts";
import { checkOrder, nameField, nameOf, type OrderBody, orderBodySchema } from "./order.ts";
import { queueFor } from "./queue.ts";
import type { Montage } from "./row.ts";
import { orderSummary } from "./summary.ts";
import { type ViewRow, view, viewColumns } from "./view.ts";
import { watchersOf } from "./watched.ts";

/**
 * The videos assembled from a memory's material (doc-03): the organizer orders
 * one, every member watches it, the organizer retries one that fell over,
 * renames it and deletes it.
 *
 * api owns the `montages` table and writes nothing else about a video: the
 * worker in `projects/montage` picks the job up, takes the row through
 * `processing` to `ready` or `failed`, fills `video_key`, `poster_key` and
 * `duration_seconds` itself, and then knocks on the internal route (`ready.ts`)
 * so everyone gets told. The two sides share exactly this: the table, the job
 * type `montage`, and that route.
 *
 * What an order may say and what this memory can honour is `order.ts`; what a
 * video looks like from outside is `view.ts`; who has watched it is
 * `watched.ts`. Here are the routes a person calls about the video itself.
 */

/**
 * Takes montages out of a memory for good — one, or all of them when the
 * memory itself goes — with the jobs still queued about them. The journal, the
 * stages, the layout and who watched cascade off the row. Answers with the
 * keys the video and the poster left in the bucket, for the caller to drop once
 * the transaction commits (`dropKeys`).
 *
 * `memories.montage_count` goes down with the rows: it is the «N роликов» on
 * the memory's card, and a video gone from the list must be gone from that
 * too. `user_usage.montage_count` does not — it counts what was ordered, which
 * a price is charged on, and a deleted video was still made.
 */
export async function removeMontages(
  tx: TransactionSql,
  memoryId: string,
  target: { montageId: string } | "everything",
) {
  const montageId = target === "everything" ? null : target.montageId;
  const gone = await tx<{ video_key: string | null; poster_key: string | null }[]>`
    with gone as (
      delete from montages
      where memory_id = ${memoryId} and (${montageId}::uuid is null or id = ${montageId}::uuid)
      returning id, video_key, poster_key
    ),
    -- Сборка, до которой очередь ещё не дошла, отменяется здесь же: её ролика
    -- больше нет, и работа над ним была бы работой в пустоту. Ту, что уже идёт,
    -- отменить некому — воркер дописывает ролик и, не найдя строки, сам
    -- убирает из хранилища то, что залил (montage video/montage.py, «went away
    -- mid-assembly»).
    queued as (
      delete from jobs where ref in (select id::text from gone)
    ),
    counted as (
      update memories set montage_count = montage_count - (select count(*) from gone)::int
      where id = ${memoryId} and exists (select 1 from gone)
    )
    select video_key, poster_key from gone
  `;
  return {
    removed: gone.length,
    keys: gone
      .flatMap((row) => [row.video_key, row.poster_key])
      .filter((key): key is string => key !== null),
  };
}

/**
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check every route here hangs on.
 */
export function montageRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const forbidden = { error: "forbidden" };

  // Built once, at registration: ajv compiles a schema once anyway.
  const orderBody = orderBodySchema();
  const renameBody = {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: { name: nameField },
  } as const;

  // «Смонтируй ролик». The organizer's line of the matrix and nobody else's
  // (architecture.md, «Проверка прав»): a contributor brought the material but
  // does not order what is made of it.
  app.post<{ Params: { memoryId: string }; Body: OrderBody }>(
    "/memories/:memoryId/montages",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: orderBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);

      // Everything the schema could not check, because all of it is a question
      // about this memory's own material — and checked before a word is
      // written, so a refusal leaves no row and no job, the rule the upload
      // intent follows with its own limits.
      const checked = await checkOrder(memory.id, request.body);
      if (!("params" in checked)) return reply.code(checked.code).send(checked.body);
      const { params } = checked;

      const montage = await sql.begin(async (tx) => {
        const [row] = await tx<ViewRow[]>`
          with m as (
            insert into montages (memory_id, ordered_by, params, name, template, photos, videos)
            values (${memory.id}, ${request.user.id}, ${sql.json(params)},
              ${nameOf(request.body?.name)}, ${request.body?.template ?? null},
              ${checked.left.photos}, ${checked.left.videos})
            returning *
          )
          select ${viewColumns} from m join users u on u.id = m.ordered_by
        `;
        if (!row) throw new Error("insert into montages returned no row");
        // Queued in the same transaction as the row, as the preview job is:
        // a job for a montage that was rolled back would have the worker
        // chasing nothing. The table belongs to montage — api only inserts.
        await tx`insert into jobs (type, ref) values ('montage', ${row.id})`;
        // The counters move with the order, not with the finished video: they
        // count what was asked for, which is what a future price is charged on
        // (architecture.md, «user_usage»). Same transaction for the reason the
        // upload counters are — a tally that can drift from what it counts is
        // worse than no tally.
        await tx`
          update memories set montage_count = montage_count + 1 where id = ${memory.id}
        `;
        await tx`
          insert into user_usage (user_id, montage_count)
          values (${request.user.id}, 1)
          on conflict (user_id) do update set
            montage_count = user_usage.montage_count + 1,
            updated_at = now()
        `;
        return row;
      });

      // Freshly queued, so there is nothing signed in this answer and no reason
      // to ask for a bucket.
      return reply.code(201).send(await view(montage, downloadTtlSeconds(), request.user.language));
    },
  );

  // «Итог перед монтажом» (doc-03): the same order, weighed and answered
  // without being placed (`summary.ts`).
  //
  // The same body, the same rights and the same checks in the same order as
  // the route above, through the one function that holds them: a summary that
  // agrees to what «Начать монтаж» will then refuse is worse than no summary
  // at all. And it writes nothing — no row, no job, no counter — so the screen
  // may be reopened as often as the organizer likes.
  app.post<{ Params: { memoryId: string }; Body: OrderBody }>(
    "/memories/:memoryId/montages/preview",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: orderBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);

      const checked = await checkOrder(memory.id, request.body);
      if (!("params" in checked)) return reply.code(checked.code).send(checked.body);

      return orderSummary(checked);
    },
  );

  // The list, apart from the gallery on purpose (doc-03: «Ролики не смешиваются
  // с галереей»). Every member reads it, `viewer` included — the matrix gives
  // them «смотреть галерею и ролики».
  app.get<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/montages",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      // The same call the gallery makes, and for the same reason: a list of
      // ready videos with `null` where their links belong would read as «ещё
      // не готово» about something that is.
      if (!storageConfigured()) {
        return reply.code(503).send({ error: "storage not configured" });
      }

      const montages = await sql<ViewRow[]>`
        select ${viewColumns} from montages m join users u on u.id = m.ordered_by
        where m.memory_id = ${request.membership.memory.id}
        order by m.created_at desc, m.id desc
      `;

      // Where the unfinished ones have got to — one query for the whole list
      // and not one per card: a memory may hold many videos and this list is
      // read often, so a query apiece would grow with the feed. Nothing is
      // written here, `montage_viewers` least of all: the list is not «я смотрю
      // сборку», it is the shelf the videos stand on.
      //
      // Only the unfinished are asked about. A ready video has no scale to draw
      // — «как собирался» is its own screen, opened from the journal route —
      // and asking about it would read five rows per finished video on every
      // list, forever.
      //
      // Who watched, the other way round: only a ready video can have been
      // watched (`watched.ts`), so only those are asked about. And only a
      // queued one waits in the queue (`queue.ts`).
      const ids = (keep: (m: ViewRow) => boolean) => montages.filter(keep).map((m) => m.id);
      const [progress, watched, queue] = await Promise.all([
        stagesFor(ids((m) => m.status !== "ready")),
        watchersOf(
          request.membership.memory.id,
          ids((m) => m.status === "ready"),
        ),
        queueFor(ids((m) => m.status === "queued")),
      ]);

      const ttl = downloadTtlSeconds();
      return Promise.all(
        montages.map(async (montage) => ({
          ...(await view(montage, ttl, request.user.language)),
          stages: progress.get(montage.id) ?? null,
          queue: queue.get(montage.id) ?? null,
          watched_by: watched.get(montage.id) ?? [],
        })),
      );
    },
  );

  // «Повторить» — the organizer's button under a video that fell over
  // (architecture.md, «Обработка ошибок»). The same row is queued again rather
  // than a second one written: the failed attempt is not a video anybody
  // ordered twice.
  app.post<{ Params: { memoryId: string; montageId: string } }>(
    "/memories/:memoryId/montages/:montageId/retry",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);
      // «Not a uuid» is «no such montage», the house rule of everything behind
      // this check (docs/auth.md, «404 один на всех»), and not a params
      // schema for the reason the media routes give: a schema answers before the
      // membership check has run, from outside the memory.
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);

      const requeued = await sql.begin(async (tx) => {
        // The status in the WHERE and not only in an `if`: two taps on the
        // button race, and whoever moves the row is the one who queues the job.
        const [row] = await tx<ViewRow[]>`
          update montages m set status = 'queued', error_text = null, updated_at = now()
          from users u
          where m.id = ${montageId} and m.memory_id = ${memory.id} and m.status = 'failed'
            and u.id = m.ordered_by
          returning ${viewColumns}
        `;
        if (!row) return undefined;
        // A clean sheet in the same breath as the status: what the attempt that
        // fell said, and how far it got, go with it. The worker wipes the
        // journal itself when it picks the job up (`journal.py`, `begin`), but
        // that is a whole queue away — and until then the card on the feed
        // would paint the old red stage under a video that is merely waiting,
        // and the journal of a `queued` montage is empty by contract
        // (docs/journal.md, «Журнал монтажа»). Deleted rather than reset to
        // `pending`, which is what the worker does on its own arrival: no rows
        // at all is «не взяли ещё» (`stagesFor`), and that is exactly what this
        // row now is.
        //
        // `montage_viewers` is left alone: it says who is looking right now,
        // which the retry does not change — and everyone on that screen is
        // about to watch this very montage go round again.
        await tx`delete from montage_journal_entries where montage_id = ${row.id}`;
        await tx`delete from montage_stages where montage_id = ${row.id}`;
        await tx`insert into jobs (type, ref) values ('montage', ${row.id})`;
        return row;
      });
      if (requeued) return view(requeued, downloadTtlSeconds(), request.user.language);

      // Nothing moved: either there is no such montage here — one answer with
      // «no such memory», as ever — or it is not a failed one, and «повторить»
      // over a video that is queued, running or already watchable would put a
      // second job on the same row.
      const [current] = await sql<Pick<Montage, "status">[]>`
        select status from montages where id = ${montageId} and memory_id = ${memory.id}
      `;
      if (!current) return reply.code(404).send(notFound);
      return reply.code(409).send({ error: "montage has not failed", status: current.status });
    },
  );

  // «Переименовать» (макет SheetFilmInfo) — the organizer's, as the order is,
  // and at any status: a name is not the worker's and nothing it does reads it.
  // A blank name hands the video back to «Ролик на 1:00».
  app.patch<{ Params: { memoryId: string; montageId: string }; Body: { name: string } }>(
    "/memories/:memoryId/montages/:montageId",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: renameBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);

      const [row] = await sql<ViewRow[]>`
        update montages m set name = ${nameOf(request.body.name)}, updated_at = now()
        from users u
        where m.id = ${montageId} and m.memory_id = ${memory.id} and u.id = m.ordered_by
        returning ${viewColumns}
      `;
      if (!row) return reply.code(404).send(notFound);
      return view(row, downloadTtlSeconds(), request.user.language);
    },
  );

  // «Удалить ролик» — the organizer's, for the reason deleting the memory is:
  // the video belongs to everybody in it, and one contributor must not take it
  // from the rest. At any status — one still being cut is let go by the worker
  // (`removeMontages`).
  app.delete<{ Params: { memoryId: string; montageId: string } }>(
    "/memories/:memoryId/montages/:montageId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);

      const { removed, keys } = await sql.begin((tx) =>
        removeMontages(tx, memory.id, { montageId }),
      );
      if (removed === 0) return reply.code(404).send(notFound);

      // After the commit and best effort, as with a deleted frame (`dropKeys`).
      await dropKeys(request.log, { keys, uploads: [] });
      return { ok: true };
    },
  );
}
