import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { downloadTtlSeconds } from "../media/config.ts";
import { storageConfigured } from "../media/r2.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { stagesFor } from "./journal.ts";
import { checkOrder, type OrderBody, orderBodySchema } from "./order.ts";
import type { Montage } from "./row.ts";
import { orderSummary } from "./summary.ts";
import { view } from "./view.ts";

/**
 * The videos assembled from a memory's material (doc-03): the organizer orders
 * one, every member watches it, the organizer retries one that fell over.
 *
 * api owns the `montages` table and writes nothing else about a video: the
 * worker in `projects/montage` picks the job up, takes the row through
 * `processing` to `ready` or `failed`, fills `video_key`, `poster_key` and
 * `duration_seconds` itself, and then knocks on the internal route (`ready.ts`)
 * so everyone gets told. The two sides share exactly this: the table, the job
 * type `montage`, and that route.
 *
 * What an order may say and what this memory can honour is `order.ts`; what a
 * video looks like from outside is `view.ts`. Here are the four routes a person
 * calls, and nothing else.
 */

/**
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check all four routes hang on.
 */
export function montageRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const forbidden = { error: "forbidden" };

  // Built once, at registration: ajv compiles a schema once anyway.
  const orderBody = orderBodySchema();

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
        const [row] = await tx<Montage[]>`
          insert into montages (memory_id, ordered_by, params)
          values (${memory.id}, ${request.user.id}, ${sql.json(params)})
          returning *
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
      return reply.code(201).send(await view(montage, downloadTtlSeconds()));
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

      const montages = await sql<Montage[]>`
        select * from montages where memory_id = ${request.membership.memory.id}
        order by created_at desc, id desc
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
      const progress = await stagesFor(
        montages.filter((m) => m.status !== "ready").map((m) => m.id),
      );

      const ttl = downloadTtlSeconds();
      return Promise.all(
        montages.map(async (montage) => ({
          ...(await view(montage, ttl)),
          stages: progress.get(montage.id) ?? null,
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
      // this check (docs/montages.md, «404 один на всех»), and not a params
      // schema for the reason the media routes give: a schema answers before the
      // membership check has run, from outside the memory.
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);

      const requeued = await sql.begin(async (tx) => {
        // The status in the WHERE and not only in an `if`: two taps on the
        // button race, and whoever moves the row is the one who queues the job.
        const [row] = await tx<Montage[]>`
          update montages set status = 'queued', error_text = null, updated_at = now()
          where id = ${montageId} and memory_id = ${memory.id} and status = 'failed'
          returning *
        `;
        if (!row) return undefined;
        // A clean sheet in the same breath as the status: what the attempt that
        // fell said, and how far it got, go with it. The worker wipes the
        // journal itself when it picks the job up (`journal.py`, `begin`), but
        // that is a whole queue away — and until then the card on the feed
        // would paint the old red stage under a video that is merely waiting,
        // and the journal of a `queued` montage is empty by contract
        // (docs/montages.md, «Журнал монтажа»). Deleted rather than reset to
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
      if (requeued) return view(requeued, downloadTtlSeconds());

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
}
