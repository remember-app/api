import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env, positive } from "../auth/config.ts";
import { bearerToken, hashToken } from "../auth/session.ts";
import { sql } from "../db.ts";
import { downloadTtlSeconds, memoryMaxFiles } from "../media/config.ts";
import { downloadUrl, storageConfigured } from "../media/r2.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { notifyMontageReady } from "../memories/push.ts";

/**
 * The videos assembled from a memory's material (doc-03): the organizer orders
 * one, every member watches it, the organizer retries one that fell over.
 *
 * api owns the `montages` table and writes nothing else about a video: the
 * worker in `projects/montage` picks the job up, takes the row through
 * `processing` to `ready` or `failed`, fills `video_key`, `poster_key` and
 * `duration_seconds` itself, and then knocks on the internal route at the bottom
 * of this file so everyone gets told. The two sides share exactly this: the
 * table, the job type `montage`, and that route.
 */

/** A `montages` row exactly as the database holds it. */
export type Montage = {
  id: string;
  memory_id: string;
  ordered_by: string;
  status: "queued" | "processing" | "ready" | "failed";
  video_key: string | null;
  /** The frame the app shows before the video plays; the worker cuts it. */
  poster_key: string | null;
  duration_seconds: number | null;
  params: {
    target_seconds?: number;
    /** What the organizer said the video is about, in their own words (doc-03). */
    story_text?: string;
    /** The frames picked out by hand: these go in, those stay out (doc-03). */
    include_media_ids?: string[];
    exclude_media_ids?: string[];
    music_track_id?: string;
    /** Their own track in R2 instead of one of the worker's; see `music.ts`. */
    music_track_key?: string;
    orientation?: (typeof orientations)[number];
  };
  error_text: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * The tracks the worker has, by id, in the order the app shows them
 * (`design/screens/MontageMusic.html`: Яркая, Тёплая, Спокойная, Ночь,
 * Дорога). Here only to refuse an id it does not hold — the files themselves
 * are the worker's, one per id, listed with their licences in
 * `projects/montage/tracks/README.md` — and the list is short enough that a
 * table for it would be a table for five strings. It is the worker's shelf that
 * decides what belongs here: when that shelf grew from three synthesized tones
 * to five real tracks, an order for `night` or `road` was refused by this
 * service alone.
 */
const musicTracks = ["bright", "warm", "calm", "night", "road"] as const;

/**
 * Which way round the video is cut (doc-03: «горизонтальный ролик или
 * вертикальный», уточнено 2026-09-09). Ordered without one means landscape,
 * and that is left as the missing key rather than written down: every montage
 * ordered before today has no `orientation` in its `params` either, so the
 * worker reads «поля нет» as landscape whatever api does — and a default
 * spelled out here would only be a key that says what its absence already
 * says. The chosen one is written, because that is a choice somebody made.
 */
const orientations = ["landscape", "portrait"] as const;

/**
 * Nothing to cut a video out of: below this a montage is refused at the order
 * rather than queued and failed by the worker (architecture.md, «Меньше 3 →
 * сразу failed»). Not a knob — it is the pipeline's own floor, not a business
 * limit, and the worker has the same number written down.
 */
const minReadyItems = 3;

/**
 * How long a story may be. A guard and not a preference: the text goes to a
 * neural network as part of the prompt (doc-03), and «опиши ролик» is a
 * paragraph or two from a person, not a novel pasted in by a client with a bug.
 * In the code rather than the environment for exactly that reason — nobody is
 * expected to tune it.
 */
const maxStoryChars = 2000;

/**
 * The two things a client may legally put in a JSON string and Postgres cannot
 * hold: a NUL, which no text column takes, and an unpaired surrogate, which
 * `jsonb` refuses outright. `params` is `jsonb`, so `story_text` — the first
 * free text this service ever wrote there — met both as a `500` on a field a
 * person types into.
 *
 * Dropped rather than refused: neither is anything anybody meant, both arrive
 * out of a paste, and «расскажите про ролик» answering «internal» over a stray
 * byte is the one thing that field must not do. A well-formed pair is a single
 * code point under `u` and is not `Cs`, so emoji come through untouched.
 */
const storable = (text: string) => text.replaceAll("\u0000", "").replace(/\p{Cs}/gu, "");

/**
 * How long a montage is asked to be, and the band it may be asked for inside.
 * In the environment for the reason the media limits are (src/media/config.ts):
 * these move once real material lands, and there is no admin screen to move
 * them from. The default is the one architecture.md names, ~60 seconds.
 */
const minTargetSeconds = () => positive("MONTAGE_TARGET_SECONDS_MIN", 15);
const maxTargetSeconds = () => positive("MONTAGE_TARGET_SECONDS_MAX", 300);

/**
 * Held inside that band rather than beside it: a default of 600 against a
 * maximum of 300 would write into `params` — and so into the worker's job — a
 * length no client could have asked for, because the schema refuses everyone
 * else outside it. Clamped rather than obeyed, which is the rule `positive`
 * itself follows about a value that is a typo instead of an intent.
 */
const targetSeconds = () =>
  Math.min(
    Math.max(positive("MONTAGE_TARGET_SECONDS", 60), minTargetSeconds()),
    maxTargetSeconds(),
  );

/** The shared secret the worker knocks with; unset means nobody may knock. */
const workerToken = () => env("INTERNAL_WORKER_TOKEN");

/**
 * Read with the session check's own two helpers, so this route takes an
 * `Authorization` header by the same rule as every other one — `bearerToken`
 * is case-insensitive on the scheme because RFC 7235 is and clients do send
 * `bearer`, and a second parser here would 401 a worker the rest of the
 * service would have let in.
 *
 * Compared through a digest rather than with `===`: `hashToken` puts both
 * sides into 32-byte buffers whatever the lengths were, so `timingSafeEqual`
 * has nothing to bail out of early. A plain string compare leaks the secret's
 * prefix to whoever is willing to measure.
 */
function knockedWithTheSecret(header: string | undefined): boolean {
  const secret = workerToken();
  // No secret configured is not «let everyone in»: it is «this route is shut».
  if (!secret) return false;
  return timingSafeEqual(hashToken(bearerToken(header)), hashToken(secret));
}

/**
 * What a montage looks like from outside: the row without its R2 keys, plus the
 * signed links — and only when there is something to link at. Everything before
 * `ready` answers `null`, which is «ещё не готово» and not an error, exactly as
 * the gallery's missing derivatives are.
 *
 * The poster follows the video through the same helper rather than a second
 * ternary beside it: both keys are the worker's, both are signed for the same
 * `ttl`, and one of them missing on a `ready` row — a video assembled before
 * the worker learned to cut a frame — is the same `null` as one still being
 * rendered.
 */
async function view(montage: Montage, ttl: number) {
  const { video_key, poster_key, ...rest } = montage;
  const link = (key: string | null) =>
    montage.status === "ready" && key ? downloadUrl(key, ttl) : null;
  return {
    ...rest,
    video_url: await link(video_key),
    poster_url: await link(poster_key),
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

  // One list of frames, used for both «включить» and «исключить». Held to
  // uuids because the handler puts these straight into a `where id in (…)`
  // against a uuid column, where «not-a-uuid» is a database error rather than a
  // 400. The ceiling is the memory's own file limit: a list longer than the
  // memory can hold files names something twice or is junk, and `uniqueItems`
  // refuses the first of those outright.
  const mediaIds = {
    type: "array",
    items: { type: "string", pattern: uuidPattern.source },
    uniqueItems: true,
    maxItems: memoryMaxFiles(),
  } as const;

  // Built here, at registration, rather than read per request as the media
  // limits are: ajv compiles a schema once, so the numbers have to be in it by
  // then. `buildApp` runs per process (and per test), which is as often as an
  // environment variable can change anyway.
  //
  // Nullable so that «no preferences at all» may arrive as an empty body, a
  // literal `null` or `{}` — three shapes of the same thing, and refusing two
  // of them would be a client bug over nothing. Not four: a zero-length body
  // sent *with* `content-type: application/json` never reaches this schema,
  // because Fastify's JSON parser refuses it first. That one is in the README
  // rather than worked around — undoing it means replacing the JSON parser for
  // every route in the service to soften one client's habit on one of them.
  const orderBody = {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
      target_seconds: {
        type: "integer",
        minimum: minTargetSeconds(),
        maximum: maxTargetSeconds(),
      },
      story_text: { type: "string", maxLength: maxStoryChars },
      include_media_ids: mediaIds,
      exclude_media_ids: mediaIds,
      music_track_id: { type: "string", enum: [...musicTracks] },
      // The key of a track the organizer uploaded (`music.ts`), which is what
      // that upload answered with. Only bounded here — whether it names a ready
      // track of *this* memory is a question for the database, below.
      music_track_key: { type: "string", maxLength: 200 },
      orientation: { type: "string", enum: [...orientations] },
    },
  } as const;

  // «Смонтируй ролик». The organizer's line of the matrix and nobody else's
  // (architecture.md, «Проверка прав»): a contributor brought the material but
  // does not order what is made of it.
  app.post<{
    Params: { memoryId: string };
    Body: {
      target_seconds?: number;
      story_text?: string;
      include_media_ids?: string[];
      exclude_media_ids?: string[];
      music_track_id?: (typeof musicTracks)[number];
      music_track_key?: string;
      orientation?: (typeof orientations)[number];
    } | null;
  }>(
    "/memories/:memoryId/montages",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: orderBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);

      // The frames the organizer picked out by hand (doc-03: «отмечает, какие
      // кадры войти должны, а какие нет»). Lowercased on the way in and on the
      // way out: Postgres hands uuids back in lower case, so a client echoing
      // an id of ours in capitals must not be told its own frame is not there,
      // and the worker must not have to compare two spellings of one id.
      //
      // And deduplicated after that, not before: the schema's `uniqueItems`
      // compares the strings as they arrived, so one frame named twice in two
      // spellings passes it and would otherwise reach the worker twice.
      const lower = (ids: string[] = []) => [...new Set(ids.map((id) => id.toLowerCase()))];
      const include = lower(request.body?.include_media_ids);
      const exclude = lower(request.body?.exclude_media_ids);
      const excluded = new Set(exclude);
      const both = include.filter((id) => excluded.has(id));
      if (both.length > 0) {
        // Not a preference the worker could resolve: «этот кадр обязательно и
        // ни в коем случае» is two orders, and picking either would be us
        // deciding what the organizer meant.
        return reply.code(400).send({
          error: "a media item cannot be both included and excluded",
          media_ids: both,
        });
      }

      // Named but not there, or there but not ready: refused by name rather
      // than dropped quietly, because a video assembled without the frame its
      // organizer insisted on looks assembled, and nothing says otherwise.
      // `ready` is the same bar the material count above holds: the worker can
      // do nothing with a file still being probed.
      const chosen = [...include, ...exclude];
      if (chosen.length > 0) {
        const found = await sql<{ id: string }[]>`
          select id from media_items
          where memory_id = ${memory.id} and status = 'ready' and id in ${sql(chosen)}
        `;
        const known = new Set(found.map((row) => row.id));
        const missing = chosen.filter((id) => !known.has(id));
        if (missing.length > 0) {
          return reply
            .code(400)
            .send({ error: "no such ready media in this memory", media_ids: missing });
        }
      }

      // Only `ready` counts: material still uploading or still being probed has
      // no derivative the worker can measure, and a video assembled out of half
      // an event is worse than one refused. Counted before anything is written,
      // so a refusal leaves no row and no job — the same rule the upload intent
      // follows with its limits.
      //
      // And counted here, after the lists have been read and checked, rather
      // than at the top of the handler: an organizer who crossed frames out is
      // ordering a video out of what is left, so the floor has to be held
      // against what is left. Counted first, a memory of five with three
      // crossed out passed a bar of three and left the worker to assemble a
      // minute from two. Every id in `exclude` is by now one distinct `ready`
      // frame of this memory — the check above sent back anything else, and the
      // set above made it distinct — so how many there are is how many frames
      // this order really takes away.
      const [material] = await sql<{ count: number }[]>`
        select count(*)::int from media_items
        where memory_id = ${memory.id} and status = 'ready'
      `;
      const ready = (material?.count ?? 0) - exclude.length;
      if (ready < minReadyItems) {
        // English like every other error body here, with the numbers beside it:
        // «недостаточно материала для ролика» is what the app says, and it says
        // it in its own words rather than showing ours. `ready_items` is what
        // this order has left, not what the memory holds: the app puts that
        // number against «нужно три», and the memory's own total would put five
        // there under a refusal.
        return reply.code(409).send({
          error: "not enough material for a montage",
          ready_items: ready,
          need: minReadyItems,
        });
      }

      // One track or the other, never both: the shelf id and an uploaded key
      // are two answers to «под что монтировать», and a row carrying both would
      // leave the worker to choose.
      //
      // Cleaned once, here, rather than only at the lookup below: an
      // `object_key` is `music/<uuid>` and never carries a NUL or a lone
      // surrogate, so a key that only *becomes* one of ours after that
      // cleaning is not a key of ours at all — and writing the client's dirty
      // original into `params` regardless would hand `jsonb` the exact byte
      // `story_text` was cleaned of, on the one field this fix forgot to.
      const trackKey = request.body?.music_track_key
        ? storable(request.body.music_track_key)
        : undefined;
      if (request.body?.music_track_id && trackKey) {
        return reply
          .code(400)
          .send({ error: "music_track_id and music_track_key are mutually exclusive" });
      }
      if (trackKey) {
        // Their own track has to be their own memory's, and finished: a key
        // from another memory, or one whose bytes never landed, is a montage
        // that fails an hour later at the worker.
        const [track] = await sql<{ id: string }[]>`
          select id from music_uploads
          where object_key = ${trackKey} and memory_id = ${memory.id}
            and status = 'ready'
        `;
        if (!track) {
          return reply
            .code(400)
            .send({ error: "no such uploaded music track", music_track_key: trackKey });
        }
      }

      // What was ordered, resolved here rather than left for the worker to
      // guess: the row is then the whole answer to «какой ролик просили», and
      // there is one place the default length lives. A track nobody chose stays
      // absent — picking one is the worker's, it holds the files — and so does
      // an orientation nobody chose, which is landscape by being missing. An
      // empty story and an empty list are «ничего не сказали» for the same
      // reason: a client clearing a field sends it empty rather than dropping
      // it, and a key that says nothing is a key not worth writing.
      const story = storable(request.body?.story_text ?? "").trim();
      const params = {
        target_seconds: request.body?.target_seconds ?? targetSeconds(),
        ...(story ? { story_text: story } : {}),
        ...(include.length > 0 ? { include_media_ids: include } : {}),
        ...(exclude.length > 0 ? { exclude_media_ids: exclude } : {}),
        ...(request.body?.music_track_id ? { music_track_id: request.body.music_track_id } : {}),
        ...(trackKey ? { music_track_key: trackKey } : {}),
        ...(request.body?.orientation ? { orientation: request.body.orientation } : {}),
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
  // It carries no state: the worker has already written `ready`, `video_key`,
  // `poster_key` and `duration_seconds` into the row itself. All this does is
  // the one thing the worker cannot, which is reach the phones.
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
      //
      // `ready` is in the WHERE for the reason it is in retry's UPDATE: this
      // route only knows how to say «ролик готов», so a row that is still
      // queued, still rendering or fell over has nothing for it to announce.
      // Without the clause a knock replayed — or aimed at any id at all by
      // whoever holds the secret — lights up every phone in the memory with a
      // link to a video that is not there.
      const [row] = await sql<{ memory_id: string; title: string }[]>`
        select m.memory_id, mem.title from montages m
        join memories mem on mem.id = m.memory_id
        where m.id = ${montageId} and m.status = 'ready'
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
