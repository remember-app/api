import type { Order } from "./order.ts";

/**
 * «Итог перед монтажом» (doc-03): what the organizer is shown about an order
 * before anybody presses «Начать монтаж» — how much goes in, from how many
 * people, how long it may be and how long the wait is
 * (`design/screens/MontageSummary.html`).
 */

/**
 * How long the worker will be at it, guessed: each frame is probed, described
 * and cut, and each second of the finished video is rendered on top of that.
 * Anchored on the numbers the screen was drawn with
 * (`design/screens/MontageSummary.html` — 214 кадров на 2:30 → «примерно за 15
 * минут»), rounded up, never under a minute, because «сейчас» is not an answer
 * to «сколько ждать».
 *
 * A guess and not a promise — the docs say so in those words. Nothing holds
 * the worker to it: the queue may be busy, a neural network may be slow, a
 * montage may fall over outright. The two rates are the worker's own per-stage
 * estimates summed (`journal.py`, `ESTIMATE`), so this and the wait its journal
 * first shows agree — they move together or not at all. The queue
 * (`queue.ts`) counts the montages ahead with the same guess.
 */
const secondsPerFrame = 3;
const secondsPerRenderedSecond = 1.5;
export const estimateSeconds = (frames: number, targetSeconds: number) =>
  frames * secondsPerFrame + targetSeconds * secondsPerRenderedSecond;
export const estimateMinutes = (frames: number, targetSeconds: number) =>
  Math.max(1, Math.ceil(estimateSeconds(frames, targetSeconds) / 60));

/** The same order, weighed and answered without being placed. */
export const orderSummary = ({ params, left }: Order) => ({
  // The frames that would go in — everything ready, less what this same
  // body crossed out and what the отсев turned down and nobody took back.
  // «Войти должен» pins a frame in the video, and adds one only when it
  // takes back what the отсев turned down (`materialLeft`).
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
});
