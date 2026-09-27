import type { Language } from "../auth/session.ts";
import { downloadUrl } from "../media/r2.ts";
import type { Montage } from "./row.ts";

/**
 * What a video is called until somebody names it: its ordered length — every
 * order writes one, a row made any other way falls back to the length it came
 * out — in the words the app puts on the same card (`ofLength`) and in the
 * language of whoever is looking (doc-8). Worked out here rather than written to the row —
 * it is a label, not a name, and a Russian and an English member of one memory
 * should each read it in their own words.
 */
function unnamed({ params, duration_seconds }: Montage, language: Language) {
  const whole = Math.round(params.target_seconds ?? duration_seconds ?? 0);
  const runtime = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  return language === "ru" ? `Ролик на ${runtime}` : `Movie of ${runtime}`;
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
export async function view(montage: Montage, ttl: number, language: Language) {
  const { video_key, poster_key, ...rest } = montage;
  const link = (key: string | null) =>
    montage.status === "ready" && key ? downloadUrl(key, ttl) : null;
  return {
    ...rest,
    name: montage.name ?? unnamed(montage, language),
    video_url: await link(video_key),
    poster_url: await link(poster_key),
  };
}
