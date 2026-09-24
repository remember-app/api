import { downloadUrl } from "../media/r2.ts";
import type { Montage } from "./row.ts";

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
export async function view(montage: Montage, ttl: number) {
  const { video_key, poster_key, ...rest } = montage;
  const link = (key: string | null) =>
    montage.status === "ready" && key ? downloadUrl(key, ttl) : null;
  return {
    ...rest,
    video_url: await link(video_key),
    poster_url: await link(poster_key),
  };
}
