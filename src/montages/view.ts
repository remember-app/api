import type { Language } from "../auth/session.ts";
import { sql } from "../db.ts";
import { downloadUrl } from "../media/r2.ts";
import type { Montage } from "./row.ts";

/**
 * What every statement whose rows go out through `view` selects: the row under
 * the alias `m`, and who ordered it off `users u` joined on `m.ordered_by`. One
 * list, as `profileColumns` is one, so no answer about a video — the order, the
 * list, a retry, a rename — can come back with the orderer's id and not their
 * name.
 */
export const viewColumns = sql`m.*, u.username as orderer_username, u.name as orderer_name`;

/** A row as `viewColumns` reads it. */
export type ViewRow = Montage & { orderer_username: string | null; orderer_name: string | null };

/**
 * What a video is called: the name somebody gave it, or else its ordered
 * length — every order writes one, a row made any other way falls back to the
 * length it came out — in the words the app puts on the same card (`ofLength`)
 * and in the language of whoever is looking (doc-8). That stand-in is worked out
 * here rather than written to the row — it is a label, not a name, and a Russian
 * and an English member of one memory should each read it in their own words. One
 * function for every answer that says a video's name, so the list and the frame
 * sheet cannot call one video two things.
 */
export function montageName(
  { name, params, duration_seconds }: Pick<Montage, "name" | "params" | "duration_seconds">,
  language: Language,
) {
  if (name !== null) return name;
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
 *
 * Who ordered it goes out as a person and not an id — the same three fields
 * `watched_by` and the frame sheet hand a person out with, in the place the
 * bare id stood.
 */
export async function view(montage: ViewRow, ttl: number, language: Language) {
  const { video_key, poster_key, orderer_username, orderer_name, ...rest } = montage;
  const link = (key: string | null) =>
    montage.status === "ready" && key ? downloadUrl(key, ttl) : null;
  return {
    ...rest,
    ordered_by: { id: montage.ordered_by, username: orderer_username, name: orderer_name },
    name: montageName(montage, language),
    video_url: await link(video_key),
    poster_url: await link(poster_key),
  };
}
