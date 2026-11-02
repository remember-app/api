import { sql } from "../db.ts";
export const minReadyItems = 3;
const minSeconds = 10;
const maxSeconds = 600;
const photoSeconds = 2.5;
const crossfadeSeconds = 0.5;
export async function materialLeft(memoryId: string, include: string[], exclude: string[]) {
  const [row] = await sql<
    {
      ready: number;
      photos: number;
      videos: number;
      people: number;
      seconds: number;
    }[]
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
  const max = Math.max(0, Math.floor(Math.min(maxSeconds, assembled)));
  return {
    ready,
    photos: row?.photos ?? 0,
    videos: row?.videos ?? 0,
    people: row?.people ?? 0,
    min_seconds: Math.min(minSeconds, max),
    max_seconds: max,
  };
}
