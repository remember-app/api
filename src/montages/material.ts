import { sql } from "../db.ts";

/**
 * What a memory's material leaves for one video — how many finished frames, of
 * what, from how many people, and the longest video they could make.
 *
 * Apart from the order it is asked for (`order.ts`) because two screens after
 * that one ask it without ordering anything (doc-03): «итог перед монтажом»
 * shows the ceiling, and a template has to be squeezed into it and say «от N
 * человек» with the number the summary will show.
 */

/**
 * Nothing to cut a video out of: below this a montage is refused at the order
 * rather than queued and failed by the worker (architecture.md, «Меньше 3 →
 * сразу failed»). Not a knob — it is the pipeline's own floor, not a business
 * limit, and the worker has the same number written down.
 */
export const minReadyItems = 3;

/**
 * The band a length may be asked for inside, which is the product's rule and
 * not a knob (doc-03, «Длина ролика — число секунд, предел: сумма всех видео
 * плюс 2,5 секунды на фото минус полсекунды на каждую склейку, но не больше 10
 * минут — обещанное число достижимо»). It used to be two environment
 * variables, and they are gone: the real ceiling is the memory's own material,
 * which no setting can know — a memory of three photos cannot make five
 * minutes of video however high a number is configured.
 *
 * A photo is worth the time it hangs on screen; a video is worth its own
 * length, and one the worker has not measured is worth nothing, which is the
 * safe way round — an unmeasured file cannot lengthen the ceiling.
 *
 * A join is the worker's crossfade, each piece laid half a second over the one
 * before: forty photos make eighty and a half seconds, not a hundred. Both
 * numbers are the worker's (`selection.PHOTO_SECONDS`, `assembly.CROSSFADE_SECONDS`
 * and `assembly.length_of` in projects/montage) and move with it, or the
 * ceiling promises a video it cannot make.
 */
const minSeconds = 10;
const maxSeconds = 600;
const photoSeconds = 2.5;
const crossfadeSeconds = 0.5;

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
 * A frame the отсев turned down counts only when the order takes it back by
 * name, and an unreadable one not even then — the worker's own rule
 * (`selection.choose`, and its floor in `montage.py`). The worker does not read
 * the stored verdict: it judges every file again at the order, with the same
 * `selection.judge` on the same copy (`screening.py`), so the stored one is the
 * answer it will come to. A frame not judged yet counts as before — a ceiling
 * there is approximate, and a guess at a verdict nobody has made would not be
 * less so (chief, 2026-09-24). «Is distinct from» and not `<>`: the two
 * screening columns are the worker's, written a repository away and held in step
 * by nothing but one line there — migration 060 declines a CHECK on purpose —
 * and a `true` with no reason beside it would turn `<>` into `null` and drop a
 * frame the organizer asked for by name.
 *
 * A frame its owner has hidden is out before any of that, and naming it in the
 * order does not bring it back: hiding is stronger than «включить», as it is in
 * the worker (migration 150, TASK-424).
 *
 * The exclusions go into the `where` rather than being subtracted afterwards:
 * counted apart, a frame deleted between the two reads gives a count that no
 * longer holds every id — and a bare subtraction then puts a negative number in
 * the answer.
 */
export async function materialLeft(memoryId: string, include: string[], exclude: string[]) {
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
    where memory_id = ${memoryId} and status = 'ready' and not hidden
      and id <> all(${exclude}::uuid[])
      and (screening_rejected is not true
        or (id = any(${include}::uuid[])
            and screening_reason is distinct from 'unreadable'))
  `;
  const ready = row?.ready ?? 0;
  const assembled = (row?.seconds ?? 0) - crossfadeSeconds * Math.max(ready - 1, 0);
  // Down to whole seconds, since only those can be ordered and a length above
  // what the material makes is one the worker cannot reach. Never under
  // nothing: three videos nobody measured are two joins with no length at all.
  const max = Math.max(0, Math.floor(Math.min(maxSeconds, assembled)));
  // The floor gives way to the ceiling rather than crossing it: a memory of
  // three photos is worth six seconds, and «не короче десяти» there would be
  // a band with nothing in it, which refuses every length there is.
  return {
    ready,
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
