import { sql } from "../db.ts";
import { estimateMinutes, estimateSeconds } from "./summary.ts";

/**
 * Ролик в очереди (doc-03, макет FilmQueued): «перед нами ещё один ролик,
 * сборка начнётся примерно через 2 минуты и займёт около 14».
 *
 * Очередь — таблица `jobs` воркера: он берёт задачи по `run_after`
 * (`worker.py`, `run_once`), и ролик ждёт всех, чья задача уже идёт или стоит
 * раньше его. Считается по роликам, а не по задачам: у повторённого их бывает
 * две — старая, до которой воркер так и не дошёл, и новая.
 */

/**
 * Где ждёт каждый из этих роликов — у кого задача в очереди есть. Одним
 * запросом на весь список, как `stagesFor`: очередь общая на все воспоминания,
 * но наружу из неё уходят только число и минуты.
 *
 * Сколько ждать — прикидка `estimateSeconds` по каждому ролику впереди, а у
 * того, что уже собирается, — сколько осталось его этапам по журналу
 * (`eta_seconds` незакрытых). Ориентир, а не обещание, как и сама прикидка.
 */
export async function queueFor(montageIds: string[]) {
  const queue = new Map<
    string,
    { ahead: number; starts_in_minutes: number; estimate_minutes: number | null }
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
