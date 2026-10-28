import { positive } from "../auth/config.ts";
import { sql } from "../db.ts";
import { lowerIds, mediaIdsSchema } from "../memories/plugin.ts";
import { materialLeft, minReadyItems } from "./material.ts";
import { musicTracks } from "./music.ts";
import type { Montage } from "./row.ts";
import { orientations, templateIds } from "./row.ts";

/**
 * An order for a video weighed against the memory it is for — what a client may
 * say, and whether this memory's own material can honour it.
 *
 * Apart from the routes that place it (`montages.ts`) because «итог перед
 * монтажом» and the six templates (doc-03) both have to know what a body would
 * be answered before anybody presses «Начать монтаж»: one function holds the
 * checks, so a summary can never agree to what the order will then refuse.
 */

/**
 * How long a story may be. A guard and not a preference: the text goes to a
 * neural network as part of the prompt (doc-03), and «опиши ролик» is a
 * paragraph or two from a person, not a novel pasted in by a client with a bug.
 * In the code rather than the environment for exactly that reason — nobody is
 * expected to tune it.
 */
const maxStoryChars = 2000;

/**
 * How long a wish about one track may be. A guard of `story_text`'s kind and
 * for its reason: the wish goes to a neural network inside the prompt, beside
 * the track it is about, and it is a line under that track, not a pasted
 * document.
 */
const maxWishChars = 500;

/**
 * How many tracks one video may be cut to. No rule says a number, and a list
 * this long is already a client bug rather than an order — a ceiling is here so
 * that «любой длины» cannot mean a megabyte of `params`.
 */
const maxTracks = 50;

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
 * What a video is called — the template's name out of the app's own dictionary,
 * or whatever the organizer typed. The memory title's ceiling, for a line of the
 * same kind. Shared by the order and by «Переименовать».
 */
export const nameField = { type: "string", maxLength: 200 } as const;

/**
 * A name as the row holds it, cleaned the way the story is. Blank is «не
 * назвали» — «Настроить самому» sends nothing, a cleared field sends "" — and
 * leaves the row without one, which `view` answers with «Ролик на 1:00».
 */
export const nameOf = (text: string | undefined) => storable(text ?? "").trim() || null;

/**
 * The body both order routes take, built at registration rather than read per
 * request as the media limits are: ajv compiles a schema once, so the numbers
 * have to be in it by then. `buildApp` runs per process (and per test), which is
 * as often as an environment variable can change anyway.
 *
 * Nullable so that «no preferences at all» may arrive as an empty body, a
 * literal `null` or `{}` — three shapes of the same thing, and refusing two
 * of them would be a client bug over nothing. Not four: a zero-length body
 * sent *with* `content-type: application/json` never reaches this schema,
 * because Fastify's JSON parser refuses it first. That one is in the docs
 * rather than worked around — undoing it means replacing the JSON parser for
 * every route in the service to soften one client's habit on one of them.
 */
export const orderBodySchema = () => {
  // One list of frames, used for both «включить» and «исключить».
  const mediaIds = mediaIdsSchema();
  return {
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
      // The other way to ask for music: hand the choice to the director rather
      // than name tracks. A flag, not a value — `true` is the whole of it, and
      // `checkOrder` refuses it beside a non-empty `music_tracks`.
      music_director: { type: "boolean" },
      // A wish per track, keyed by the track as `music_tracks` names it. Which
      // keys belong to this order is `checkOrder`'s question: it needs the
      // tracks cleaned first.
      music_wishes: {
        type: "object",
        additionalProperties: { type: "string", maxLength: maxWishChars },
      },
      orientation: { type: "string", enum: [...orientations] },
      // Not knobs for the worker, so each goes to its own column and not into
      // `params`; «итог перед монтажом» takes them and has nothing to say about
      // either. The template is the card the order started from — what it
      // filled in is already the rest of this body.
      name: nameField,
      template: { type: "string", enum: [...templateIds] },
      // The one-track fields `music_tracks` replaced. Refused rather than
      // stripped like an invented field: a client still naming its track this
      // way would get a video with no music and no word about why.
      music_track_id: false,
      music_track_key: false,
    },
  } as const;
};

/** Everything a client may say when ordering a video; every word of it optional. */
export type OrderBody = {
  target_seconds?: number;
  story_text?: string;
  include_media_ids?: string[];
  exclude_media_ids?: string[];
  music_tracks?: string[];
  music_director?: boolean;
  music_wishes?: Record<string, string>;
  orientation?: (typeof orientations)[number];
  name?: string;
  template?: (typeof templateIds)[number];
} | null;

/**
 * An order this memory can honour: the `params` to write, beside the material
 * they were weighed against.
 *
 * The material comes back with them because it was counted to get them: «итог
 * перед монтажом» shows exactly those numbers, and asking the database a second
 * time for what this call already read would be one more query and one more
 * chance for the two answers to disagree. The length is always among the params
 * — the order writes a default when nobody named one — and is typed as such so
 * the summary need not pretend it might be missing.
 */
export type Order = {
  params: Montage["params"] & { target_seconds: number };
  left: Awaited<ReturnType<typeof materialLeft>>;
};

/** Either the `params` to write, or the answer to send instead of writing. */
export type Checked = Order | { code: number; body: object };

/**
 * An order weighed against the memory it is for — the frames it picks out, the
 * tracks it asks for, the length it wants — answered with either the `params`
 * to write or the refusal to send back. Everything the schema cannot check,
 * because all of it is a question about this memory's own material.
 */
export async function checkOrder(memoryId: string, body: OrderBody): Promise<Checked> {
  // The frames the organizer picked out by hand (doc-03: «отмечает, какие
  // кадры войти должны, а какие нет»). Normalised before anything else, so the
  // worker never gets one id in two spellings, or twice.
  const include = lowerIds(body?.include_media_ids);
  const exclude = lowerIds(body?.exclude_media_ids);
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
  const left = await materialLeft(memoryId, include, exclude);
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
  // «Пусть выберет режиссёр» and «играй вот эти» at once is two orders about
  // the same music, and obeying either would be us deciding which the organizer
  // meant — the same refusal a frame in both lists gets. An empty list beside
  // the flag is not a contradiction: «без треков» is what the flag already says.
  const director = body?.music_director === true;
  if (director && tracks.length > 0) {
    return { code: 400, body: { error: "music_director cannot be combined with music_tracks" } };
  }
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

  // A wish is written to one track and goes to the worker with it, so it has
  // to name a track this order plays: any other — and with no tracks, every
  // one — is a wish the worker cannot honour, refused with each such key named
  // rather than dropped. Key and text are cleaned the way the tracks are, so a
  // key matches its track after cleaning just as the track itself does; a wish
  // the cleaning empties, or that came empty, says nothing about anything and
  // is dropped before it is weighed — «очистил поле» is «не сказал».
  const wishes = Object.fromEntries(
    Object.entries(body?.music_wishes ?? {})
      .map(([name, wish]) => [storable(name), storable(wish).trim()] as const)
      .filter(([, wish]) => wish),
  );
  const played = new Set(tracks);
  const astray = Object.keys(wishes).filter((name) => !played.has(name));
  if (astray.length > 0) {
    return {
      code: 400,
      body: { error: "music wish for a track not in music_tracks", music_wishes: astray },
    };
  }

  // Not said is the default, squeezed into this memory's band — which is where
  // a memory of three photos gets a six-second video instead of a refusal
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
  // `warm` by default — by nothing but the field being there. Handed to the
  // director, the two swap places: the flag is written and the list is not, so
  // «режиссёр выберет» and «без музыки» stay two different rows. The wishes are
  // not an exception: no wish written is «ничего не пожелали».
  const story = storable(body?.story_text ?? "").trim();
  return {
    params: {
      target_seconds: target,
      ...(story ? { story_text: story } : {}),
      ...(include.length > 0 ? { include_media_ids: include } : {}),
      ...(exclude.length > 0 ? { exclude_media_ids: exclude } : {}),
      ...(director ? { music_director: true } : { music_tracks: tracks }),
      ...(Object.keys(wishes).length > 0 ? { music_wishes: wishes } : {}),
      ...(body?.orientation ? { orientation: body.orientation } : {}),
    },
    left,
  };
}
