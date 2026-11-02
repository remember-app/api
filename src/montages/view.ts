import type { Language } from "../auth/session.ts";
import { sql } from "../db.ts";
import { downloadUrl } from "../media/r2.ts";
import type { Montage } from "./row.ts";
export const viewColumns = sql`m.*, u.username as orderer_username, u.name as orderer_name`;
export type ViewRow = Montage & {
  orderer_username: string | null;
  orderer_name: string | null;
};
export function montageName(
  { name, params, duration_seconds }: Pick<Montage, "name" | "params" | "duration_seconds">,
  language: Language,
) {
  if (name !== null) return name;
  const whole = Math.round(params.target_seconds ?? duration_seconds ?? 0);
  const runtime = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  return language === "ru" ? `Ролик на ${runtime}` : `Movie of ${runtime}`;
}
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
