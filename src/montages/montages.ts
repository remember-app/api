import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env, positive } from "../auth/config.ts";
import { bearerToken, hashToken } from "../auth/session.ts";
import { sql } from "../db.ts";
import { downloadTtlSeconds, memoryMaxFiles } from "../media/config.ts";
import { downloadUrl, storageConfigured } from "../media/r2.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { notifyMontageReady } from "../memories/push.ts";
import { montageStages, type StageRow } from "./journal.ts";

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
    /**
     * The music, in the order it plays: shelf ids (`musicTracks`) and keys of
     * the organizer's own tracks, mixed as they like (doc-03). Written on every
     * new order even when it is empty — empty *is* the answer «без музыки», and
     * the worker can only tell it from an old order that never carried the field
     * by the field being there.
     */
    music_tracks?: string[];
    /** «Как использовать треки», in the organizer's own words (doc-03). */
    music_note?: string;
    /**
     * Old rows only — the one track an order used to name, before
     * `music_tracks`. Nothing writes these any more and no order may ask for
     * them; they are read because the videos ordered with them are still in
     * the list, and repeating a failed one replays its own `params`.
     */
    music_track_id?: string;
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
 * Дорога). To refuse an id it does not hold, and — exported — to name the one
 * file the preview route signs (`music.ts`). The files themselves are the
 * worker's, one per id, listed with their licences in
 * `projects/montage/tracks/README.md` — and the list is short enough that a
 * table for it would be a table for five strings. It is the worker's shelf that
 * decides what belongs here: when that shelf grew from three synthesized tones
 * to five real tracks, an order for `night` or `road` was refused by this
 * service alone.
 */
export const musicTracks = ["bright", "warm", "calm", "night", "road"] as const;

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
 * How long a montage is when nobody said — the ~60 seconds architecture.md
 * names. In the environment for the reason the media limits are
 * (src/media/config.ts): it moves once real material lands, and there is no
 * admin screen to move it from. Held inside the memory's own band before it is
 * written (`checkOrder`), because a default outside it would put into `params`
 * — and so into the worker's job — a length no client could have asked for.
 */
const defaultTargetSeconds = () => positive("MONTAGE_TARGET_SECONDS", 60);

/**
 * The band a length may be asked for inside, which is the product's rule and
 * not a knob (doc-03, «Длина ролика — число секунд, предел: сумма всех видео
 * плюс 2,5 секунды на фото, но не больше 10 минут»). It used to be two
 * environment variables, and they are gone: the real ceiling is the memory's
 * own material, which no setting can know — a memory of three photos cannot
 * make five minutes of video however high a number is configured.
 *
 * A photo is worth the time it hangs on screen; a video is worth its own
 * length, and one the worker has not measured is worth nothing, which is the
 * safe way round — an unmeasured file cannot lengthen the ceiling.
 */
const minSeconds = 10;
const maxSeconds = 600;
const photoSeconds = 2.5;

/**
 * How long the note about the music may be. A guard of `story_text`'s kind and
 * for its reason: «как использовать треки» goes to a neural network inside the
 * prompt, and it is a sentence or two, not a pasted document.
 */
const maxNoteChars = 500;

/**
 * How many tracks one video may be cut to. No rule says a number, and a list
 * this long is already a client bug rather than an order — a ceiling is here so
 * that «любой длины» cannot mean a megabyte of `params`.
 */
const maxTracks = 50;

/**
 * What this order has to work with: how many finished frames are left once the
 * crossed-out ones are gone, what they are, whose they are, and the longest
 * video they could make.
 *
 * One query for both because it is one question — «что останется в ролике» —
 * and both answers are read off the same rows. Only `ready` counts, as
 * everywhere here: material still uploading or still being probed has no
 * derivative the worker can measure, and no length either.
 *
 * The exclusions go into the `where` rather than being subtracted afterwards:
 * counted apart, a frame deleted between the two reads gives a count that no
 * longer holds every id — and a bare subtraction then puts a negative number in
 * the answer.
 *
 * Apart from the route because two screens after this one ask it without
 * ordering anything (doc-03): «итог перед монтажом» shows the ceiling, and a
 * template has to be squeezed into it and say «от N человек» with the number the
 * summary will show.
 */
export async function materialLeft(memoryId: string, exclude: string[] = []) {
  const [row] = await sql<
    { ready: number; photos: number; videos: number; people: number; seconds: number }[]
  >`
    select
      count(*)::int as ready,
      count(*) filter (where kind = 'photo')::int as photos,
      count(*) filter (where kind = 'video')::int as videos,
      count(distinct uploaded_by)::int as people,
      coalesce(sum(
        case when kind = 'video' then coalesce(duration_seconds, 0) else ${photoSeconds} end
      ), 0)::float8 as seconds
    from media_items
    where memory_id = ${memoryId} and status = 'ready' and id <> all(${exclude}::uuid[])
  `;
  const max = Math.floor(Math.min(maxSeconds, row?.seconds ?? 0));
  // The floor gives way to the ceiling rather than crossing it: a memory of
  // three photos is worth seven seconds, and «не короче десяти» there would be
  // a band with nothing in it, which refuses every length there is.
  return {
    ready: row?.ready ?? 0,
    // Split by kind and by whose they are for «итог перед монтажом» (doc-03):
    // «168 фото · 46 видео, от 5 человек» is this same set of rows counted
    // three more ways, so it is this same query — a second one asked a moment
    // later could answer about different material.
    photos: row?.photos ?? 0,
    videos: row?.videos ?? 0,
    people: row?.people ?? 0,
    min_seconds: Math.min(minSeconds, max),
    max_seconds: max,
  };
}

/**
 * How long the worker will be at it, guessed: each frame is probed, described
 * and cut, and each second of the finished video is rendered on top of that.
 * Anchored on the numbers the screen was drawn with
 * (`design/screens/MontageSummary.html` — 214 кадров на 2:30 → «примерно за 15
 * минут»), rounded up, never under a minute, because «сейчас» is not an answer
 * to «сколько ждать».
 *
 * A guess and not a promise — the README says so in those words. Nothing holds
 * the worker to it: the queue may be busy, a neural network may be slow, a
 * montage may fall over outright. The two rates are the worker's own per-stage
 * estimates summed (`journal.py`, `ESTIMATE`), so this and the wait its journal
 * first shows agree — they move together or not at all.
 */
const secondsPerFrame = 3;
const secondsPerRenderedSecond = 1.5;
const estimateMinutes = (frames: number, targetSeconds: number) =>
  Math.max(
    1,
    Math.ceil((frames * secondsPerFrame + targetSeconds * secondsPerRenderedSecond) / 60),
  );

/** Everything a client may say when ordering a video; every word of it optional. */
export type OrderBody = {
  target_seconds?: number;
  story_text?: string;
  include_media_ids?: string[];
  exclude_media_ids?: string[];
  music_tracks?: string[];
  music_note?: string;
  orientation?: (typeof orientations)[number];
} | null;

/**
 * Either the `params` to write, or the answer to send instead of writing.
 *
 * The material comes back beside the `params` because it was counted to get
 * them: «итог перед монтажом» shows exactly those numbers, and asking the
 * database a second time for what this call already read would be one more
 * query and one more chance for the two answers to disagree. The length is
 * always among the params — the order writes a default when nobody named one —
 * and is typed as such so the summary need not pretend it might be missing.
 */
export type Checked =
  | {
      params: Montage["params"] & { target_seconds: number };
      left: Awaited<ReturnType<typeof materialLeft>>;
    }
  | { code: number; body: object };

/**
 * An order weighed against the memory it is for — the frames it picks out, the
 * tracks it asks for, the length it wants — answered with either the `params`
 * to write or the refusal to send back. Everything the schema cannot check,
 * because all of it is a question about this memory's own material.
 *
 * Apart from the write for `materialLeft`'s reason: «итог перед монтажом» and
 * the six templates (doc-03) both have to know what a body would be answered
 * before anybody presses «Начать монтаж».
 */
export async function checkOrder(memoryId: string, body: OrderBody): Promise<Checked> {
  // The frames the organizer picked out by hand (doc-03: «отмечает, какие
  // кадры войти должны, а какие нет»). Lowercased on the way in and on the way
  // out: Postgres hands uuids back in lower case, so a client echoing an id of
  // ours in capitals must not be told its own frame is not there, and the
  // worker must not have to compare two spellings of one id.
  //
  // And deduplicated after that, not before: the schema's `uniqueItems`
  // compares the strings as they arrived, so one frame named twice in two
  // spellings passes it and would otherwise reach the worker twice.
  const lower = (ids: string[] = []) => [...new Set(ids.map((id) => id.toLowerCase()))];
  const include = lower(body?.include_media_ids);
  const exclude = lower(body?.exclude_media_ids);
  const excluded = new Set(exclude);
  const both = include.filter((id) => excluded.has(id));
  if (both.length > 0) {
    // Not a preference the worker could resolve: «этот кадр обязательно и ни в
    // коем случае» is two orders, and picking either would be us deciding what
    // the organizer meant.
    return {
      code: 400,
      body: { error: "a media item cannot be both included and excluded", media_ids: both },
    };
  }

  // Named but not there, or there but not ready: refused by name rather than
  // dropped quietly, because a video assembled without the frame its organizer
  // insisted on looks assembled, and nothing says otherwise. `ready` is the
  // same bar the material count below holds: the worker can do nothing with a
  // file still being probed.
  const chosen = [...include, ...exclude];
  if (chosen.length > 0) {
    const found = await sql<{ id: string }[]>`
      select id from media_items
      where memory_id = ${memoryId} and status = 'ready' and id in ${sql(chosen)}
    `;
    const known = new Set(found.map((row) => row.id));
    const missing = chosen.filter((id) => !known.has(id));
    if (missing.length > 0) {
      return {
        code: 400,
        body: { error: "no such ready media in this memory", media_ids: missing },
      };
    }
  }

  // Counted here, after the lists have been read and checked, rather than
  // first: an organizer who crossed frames out is ordering a video out of what
  // is left, so the floor has to be held against what is left. Counted first, a
  // memory of five with three crossed out passed a bar of three and left the
  // worker to assemble a minute from two.
  const left = await materialLeft(memoryId, exclude);
  const { ready, min_seconds, max_seconds } = left;
  // A ceiling of nothing — every frame left a video nobody measured — is too
  // little material as well: the band is then 0…0, and 0 is the one length the
  // worker reads as «не сказали» and cuts a minute out of.
  if (ready < minReadyItems || max_seconds === 0) {
    // English like every other error body here, with the numbers beside it:
    // «недостаточно материала для ролика» is what the app says, and it says it
    // in its own words rather than showing ours. `ready_items` is what this
    // order has left, not what the memory holds.
    return {
      code: 409,
      body: { error: "not enough material for a montage", ready_items: ready, need: minReadyItems },
    };
  }

  // Cleaned the way the story is: a value that only *becomes* one of ours
  // after cleaning is not one of ours at all, and writing the client's dirty
  // original into `params` would hand `jsonb` the exact byte it refuses.
  // Emptied by the cleaning, or empty as it came, it names nothing and is
  // dropped — «очистил поле» is «не сказал».
  const asked = body?.music_tracks ?? [];
  const tracks = [...new Set(asked.map((name) => storable(name)).filter((name) => name))];
  // A shelf id or a key of this memory's own track, in one list on purpose: the
  // order is the order they play in, and the worker downloads both the same
  // way. The shelf is checked against the very list «Послушать» is checked
  // against (`music.ts`), so the two can never disagree about which tracks
  // exist.
  const shelf = new Set<string>(musicTracks);
  const keys = tracks.filter((name) => !shelf.has(name));
  if (keys.length > 0) {
    // Their own track has to be their own memory's, and finished: a key from
    // another memory, or one whose bytes never landed, is a montage that fails
    // an hour later at the worker.
    const found = await sql<{ object_key: string }[]>`
      select object_key from music_uploads
      where memory_id = ${memoryId} and status = 'ready' and object_key in ${sql(keys)}
    `;
    const known = new Set(found.map((row) => row.object_key));
    const missing = keys.filter((key) => !known.has(key));
    if (missing.length > 0) {
      return { code: 400, body: { error: "no such music track", music_tracks: missing } };
    }
  }

  // «Как использовать треки» is about tracks: with none named there is nothing
  // for it to be about, and the worker would have a wish it cannot honour.
  // Refused by name rather than dropped, which is this service's rule about a
  // field it will not act on.
  const note = storable(body?.music_note ?? "").trim();
  if (note && tracks.length === 0) {
    return { code: 400, body: { error: "music_note needs music_tracks" } };
  }

  // Not said is the default, squeezed into this memory's band — which is where
  // a memory of three photos gets a seven-second video instead of a refusal
  // nobody asked for. Said is obeyed or refused with both numbers, so the app
  // can move its slider to the edge rather than guess where the edge was.
  const target =
    body?.target_seconds ?? Math.min(Math.max(defaultTargetSeconds(), min_seconds), max_seconds);
  if (target < min_seconds || target > max_seconds) {
    return { code: 400, body: { error: "target_seconds out of range", min_seconds, max_seconds } };
  }

  // What was ordered, resolved here rather than left for the worker to guess:
  // the row is then the whole answer to «какой ролик просили». An orientation
  // nobody chose stays absent — that is landscape by being missing. An empty
  // story and an empty list are «ничего не сказали» for the same reason: a
  // client clearing a field sends it empty rather than dropping it, and a key
  // that says nothing is a key not worth writing. The tracks are the one
  // exception and are always written, empty list and all: the worker tells
  // «без музыки» from an order made before this field existed — where it played
  // `warm` by default — by nothing but the field being there.
  const story = storable(body?.story_text ?? "").trim();
  return {
    params: {
      target_seconds: target,
      ...(story ? { story_text: story } : {}),
      ...(include.length > 0 ? { include_media_ids: include } : {}),
      ...(exclude.length > 0 ? { exclude_media_ids: exclude } : {}),
      music_tracks: tracks,
      ...(note ? { music_note: note } : {}),
      ...(body?.orientation ? { orientation: body.orientation } : {}),
    },
    left,
  };
}

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

/** A `montage_stages` row, cut down to what a card on the feed draws with. */
type StageProgress = Pick<StageRow, "stage" | "state"> & { montage_id: string };

/**
 * How far a video that is still being assembled has got: the five stages in
 * pipeline order, each with its state. The card on the feed draws a bar apiece
 * and counts «3 из 5» off them itself (`design/screens/MemoryFrames.html`,
 * `design/spec.md` №38) — so the app need not open the journal of every card in
 * the list to know that.
 *
 * States and not a bare «3 из 5»: the scale is five bars, and a failed one is
 * its own colour — a count cannot say which stage fell. Named and not merely
 * ordered, for the same reason the journal names them: a client reading a
 * position rather than a name has a contract nobody wrote down.
 *
 * A stage the worker has laid no row for is `pending` rather than missing: it
 * writes them one at a time, as it reaches them, and five bars have to be five
 * whatever it has got round to. Nothing at all — not one row — is `null`: that
 * is a video the worker has not picked up yet, and a scale of five empty bars
 * would claim it is under way.
 */
const stagesOf = (montageId: string, rows: StageProgress[]) => {
  const state = new Map(
    rows.filter((row) => row.montage_id === montageId).map((row) => [row.stage, row.state]),
  );
  if (state.size === 0) return null;
  return montageStages.map((stage) => ({ stage, state: state.get(stage) ?? "pending" }));
};

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
      // Whole seconds and nothing else here: the band it has to be inside is
      // this memory's own material, which a schema compiled once cannot know
      // (`checkOrder` holds it, and answers with both edges).
      target_seconds: { type: "integer" },
      story_text: { type: "string", maxLength: maxStoryChars },
      include_media_ids: mediaIds,
      exclude_media_ids: mediaIds,
      // The music, in playing order: shelf ids and keys of the organizer's own
      // tracks in one list. Only bounded here — which of them exist, and whose
      // memory a key belongs to, is a question for the database.
      music_tracks: {
        type: "array",
        items: { type: "string", maxLength: 200 },
        uniqueItems: true,
        maxItems: maxTracks,
      },
      music_note: { type: "string", maxLength: maxNoteChars },
      orientation: { type: "string", enum: [...orientations] },
      // The one-track fields `music_tracks` replaced. Refused rather than
      // stripped like an invented field: a client still naming its track this
      // way would get a video with no music and no word about why.
      music_track_id: false,
      music_track_key: false,
    },
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
  // without being placed — how much goes in, from how many people, how long it
  // may be and how long the wait is (`design/screens/MontageSummary.html`).
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
      const { params, left } = checked;

      return {
        // The frames that would go in — everything ready, less what this same
        // body crossed out. The included ones are already among them: «войти
        // должен» pins a frame in the video, it does not add one.
        photos: left.photos,
        videos: left.videos,
        people: left.people,
        min_seconds: left.min_seconds,
        max_seconds: left.max_seconds,
        // What the order would write down, default and all — the app shows the
        // length it is about to ask for, not the one it did not name.
        target_seconds: params.target_seconds,
        // Missing in `params` is landscape (see `orientations`). The screen
        // needs the word out loud, so it is said here rather than left for
        // every client to know the convention.
        orientation: params.orientation ?? "landscape",
        estimate_minutes: estimateMinutes(left.ready, params.target_seconds),
      };
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
      const building = montages.filter((m) => m.status !== "ready").map((m) => m.id);
      const stages =
        building.length > 0
          ? await sql<StageProgress[]>`
              select montage_id, stage, state from montage_stages
              where montage_id in ${sql(building)}
            `
          : [];

      const ttl = downloadTtlSeconds();
      return Promise.all(
        montages.map(async (montage) => ({
          ...(await view(montage, ttl)),
          stages: stagesOf(montage.id, stages),
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
        // A clean sheet in the same breath as the status: what the attempt that
        // fell said, and how far it got, go with it. The worker wipes the
        // journal itself when it picks the job up (`journal.py`, `begin`), but
        // that is a whole queue away — and until then the card on the feed
        // would paint the old red stage under a video that is merely waiting,
        // and the journal of a `queued` montage is empty by contract (README,
        // «Журнал монтажа»). Deleted rather than reset to `pending`, which is
        // what the worker does on its own arrival: no rows at all is «не взяли
        // ещё» (`stagesOf`), and that is exactly what this row now is.
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
