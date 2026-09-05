import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { positive } from "../auth/config.ts";
import { sql } from "../db.ts";
import { downloadTtlSeconds } from "../media/config.ts";
import { downloadUrl, storageConfigured } from "../media/r2.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { notifyMontageReady } from "../memories/push.ts";

/**
 * The videos assembled from a memory's material (doc-03): the organizer orders
 * one, every member watches it, the organizer retries one that fell over.
 *
 * api owns the `montages` table and writes nothing else about a video: the
 * worker in `projects/montage` picks the job up, takes the row through
 * `processing` to `ready` or `failed`, fills `video_key` and `duration_seconds`
 * itself, and then knocks on the internal route at the bottom of this file so
 * everyone gets told. The two sides share exactly this: the table, the job type
 * `montage`, and that route.
 */

/** A `montages` row exactly as the database holds it. */
export type Montage = {
  id: string;
  memory_id: string;
  ordered_by: string;
  status: "queued" | "processing" | "ready" | "failed";
  video_key: string | null;
  duration_seconds: number | null;
  params: { target_seconds?: number; music_track_id?: string };
  error_text: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * The tracks the worker has, by id. Here only to refuse an id it does not hold
 * — the files themselves are the worker's (architecture.md, «Montage-пайплайн»)
 * — and the list is short enough that a table for it would be a table for three
 * strings.
 */
const musicTracks = ["warm", "bright", "calm"] as const;

/**
 * Nothing to cut a video out of: below this a montage is refused at the order
 * rather than queued and failed by the worker (architecture.md, «Меньше 3 →
 * сразу failed»). Not a knob — it is the pipeline's own floor, not a business
 * limit, and the worker has the same number written down.
 */
const minReadyItems = 3;

/**
 * How long a montage is asked to be. In the environment for the reason the
 * media limits are (src/media/config.ts): these move once real material lands,
 * and there is no admin screen to move them from. The default is the one
 * architecture.md names, ~60 seconds.
 */
const targetSeconds = () => positive("MONTAGE_TARGET_SECONDS", 60);
const minTargetSeconds = () => positive("MONTAGE_TARGET_SECONDS_MIN", 15);
const maxTargetSeconds = () => positive("MONTAGE_TARGET_SECONDS_MAX", 300);

/** The shared secret the worker knocks with; unset means nobody may knock. */
const workerToken = () => process.env.INTERNAL_WORKER_TOKEN?.trim() || undefined;

/**
 * Compared through a digest rather than with `===`: both sides are hashed
 * first, so the comparison is over two 32-byte buffers whatever the lengths
 * were, and `timingSafeEqual` has nothing to bail out of early. A plain string
 * compare leaks the secret's prefix to whoever is willing to measure.
 */
const digest = (value: string) => createHash("sha256").update(value).digest();

function knockedWithTheSecret(header: string | undefined): boolean {
  const secret = workerToken();
  // No secret configured is not «let everyone in»: it is «this route is shut».
  if (!secret) return false;
  const given = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return timingSafeEqual(digest(given), digest(secret));
}

/**
 * What a montage looks like from outside: the row without its R2 key, plus the
 * signed link — and only when there is something to link at. Everything before
 * `ready` answers `null`, which is «ещё не готово» and not an error, exactly as
 * the gallery's missing derivatives are.
 */
async function view(montage: Montage, ttl: number) {
  const { video_key, ...rest } = montage;
  return {
    ...rest,
    video_url: montage.status === "ready" && video_key ? await downloadUrl(video_key, ttl) : null,
  };
}

/**
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check the first three routes hang on. The fourth hangs on nothing
 * — it is the worker's, not a person's.
 */
export function montageRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const forbidden = { error: "forbidden" };

  // Built here, at registration, rather than read per request as the media
  // limits are: ajv compiles a schema once, so the numbers have to be in it by
  // then. `buildApp` runs per process (and per test), which is as often as an
  // environment variable can change anyway.
  //
  // Nullable so that «no preferences at all» may arrive as an empty body, a
  // literal `null` or `{}` — three shapes of the same thing, and refusing two
  // of them would be a client bug over nothing.
  const orderBody = {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
      target_seconds: {
        type: "integer",
        minimum: minTargetSeconds(),
        maximum: maxTargetSeconds(),
      },
      music_track_id: { type: "string", enum: [...musicTracks] },
    },
  } as const;

  // «Смонтируй ролик». The organizer's line of the matrix and nobody else's
  // (architecture.md, «Проверка прав»): a contributor brought the material but
  // does not order what is made of it.
  app.post<{
    Params: { memoryId: string };
    Body: { target_seconds?: number; music_track_id?: (typeof musicTracks)[number] } | null;
  }>(
    "/memories/:memoryId/montages",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: orderBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);

      // Only `ready` counts: material still uploading or still being probed has
      // no derivative the worker can measure, and a video assembled out of half
      // an event is worse than one refused. Counted before anything is written,
      // so a refusal leaves no row and no job — the same rule the upload intent
      // follows with its limits.
      const [material] = await sql<{ count: number }[]>`
        select count(*)::int from media_items
        where memory_id = ${memory.id} and status = 'ready'
      `;
      const ready = material?.count ?? 0;
      if (ready < minReadyItems) {
        // English like every other error body here, with the numbers beside it:
        // «недостаточно материала для ролика» is what the app says, and it says
        // it in its own words rather than showing ours.
        return reply.code(409).send({
          error: "not enough material for a montage",
          ready_items: ready,
          need: minReadyItems,
        });
      }

      // What was ordered, resolved here rather than left for the worker to
      // guess: the row is then the whole answer to «какой ролик просили», and
      // there is one place the default length lives. A track nobody chose stays
      // absent — picking one is the worker's, it holds the files.
      const params = {
        target_seconds: request.body?.target_seconds ?? targetSeconds(),
        ...(request.body?.music_track_id ? { music_track_id: request.body.music_track_id } : {}),
      };

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
      const ttl = downloadTtlSeconds();
      return Promise.all(montages.map((montage) => view(montage, ttl)));
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
      // this check (README, «404 один на всех»), and not a params schema for
      // the reason the media routes give: a schema answers before the
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

  // The worker knocking: «this one is ready, tell them». Deliberately outside
  // `app.authenticate` — there is no person behind this call and no session to
  // check — and so behind a shared secret instead.
  //
  // It carries no state: the worker has already written `ready`, `video_key`
  // and `duration_seconds` into the row itself. All this does is the one thing
  // the worker cannot, which is reach the phones.
  app.post<{ Params: { montageId: string } }>(
    "/internal/montages/:montageId/ready",
    async (request, reply) => {
      if (!knockedWithTheSecret(request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);

      // The title is what the notification is about, so it is read here and not
      // in the sender — one query, and the join is also the check that the
      // montage exists at all.
      const [row] = await sql<{ memory_id: string; title: string }[]>`
        select m.memory_id, mem.title from montages m
        join memories mem on mem.id = m.memory_id
        where m.id = ${montageId}
      `;
      if (!row) return reply.code(404).send(notFound);

      await notifyMontageReady(request.log, { id: row.memory_id, title: row.title }, montageId);
      // `ok` however the sending went: the video is ready whether or not a
      // phone heard about it, and a worker told otherwise would retry a job
      // whose whole work is done (`notifyMontageReady` never throws).
      return { ok: true };
    },
  );
}
