import { sql } from "../db.ts";
import { estimateMinutes, estimateSeconds } from "./summary.ts";
export async function queueFor(montageIds: string[]) {
  const queue = new Map<
    string,
    {
      ahead: number;
      starts_in_minutes: number;
      estimate_minutes: number | null;
    }
  >();
  if (montageIds.length === 0) return queue;
  const line = await sql<
    {
      id: string;
      frames: number | null;
      target_seconds: number;
      left_seconds: number | null;
    }[]
  >`
    select m.id, m.photos + m.videos as frames,
      coalesce((m.params->>'target_seconds')::float8, 0) as target_seconds,
      -- having count(*) > 0, а не только coalesce: у ролика, до которого воркер
      -- не дошёл, строк этапа нет вовсе, и без него он ждал бы ноль — то есть
      -- «начинайся сейчас». Пусто значит «оценки нет», и wait ниже берёт прикидку.
      (select coalesce(sum(s.eta_seconds) filter (where s.state <> 'done'), 0)::float8
         from montage_stages s where s.montage_id = m.id
         having count(*) > 0) as left_seconds
    from jobs j join montages m on m.id::text = j.ref
    where j.type = 'montage' and j.status in ('queued', 'running')
    group by m.id
    order by bool_or(j.status = 'running') desc, min(j.run_after), min(j.id)
  `;
  const wanted = new Set(montageIds);
  let waited = 0;
  for (const [ahead, { id, frames, target_seconds, left_seconds }] of line.entries()) {
    if (wanted.has(id)) {
      queue.set(id, {
        ahead,
        starts_in_minutes: Math.ceil(waited / 60),
        estimate_minutes: frames === null ? null : estimateMinutes(frames, target_seconds),
      });
    }
    waited += left_seconds ?? estimateSeconds(frames ?? 0, target_seconds);
  }
  return queue;
}
