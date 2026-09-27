import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";
import type { Montage } from "./row.ts";

/**
 * «Посмотрели» (doc-03, макет SheetFilmInfo): кто из участников уже открывал
 * готовый ролик. Факт, а не история: строка на человека, и второй показ её не
 * трогает.
 *
 * Ссылку на ролик приложение берёт из списка и играет с хранилища напрямую —
 * до api показ не доходит, поэтому экран ролика стучится сюда сам, когда
 * открылся. Не путать с `montage_viewers` журнала: там «кто смотрит сборку
 * прямо сейчас», и живёт отметка секунды.
 */

type Watcher = { id: string; username: string | null; name: string | null };

/**
 * Кто смотрел каждый из роликов, одним запросом на весь список — как `stagesFor`.
 * Только нынешние участники: ушедший из воспоминания в «4 из 6» не входит, а
 * строка его остаётся — вернётся, и снова будет среди посмотревших.
 */
export async function watchersOf(memoryId: string, montageIds: string[]) {
  const byMontage = new Map<string, Watcher[]>();
  if (montageIds.length === 0) return byMontage;
  const rows = await sql<({ montage_id: string } & Watcher)[]>`
    select w.montage_id, u.id, u.username, u.name
    from montage_watches w
    join memory_members m on m.memory_id = ${memoryId} and m.user_id = w.user_id
    join users u on u.id = w.user_id
    where w.montage_id in ${sql(montageIds)}
    order by w.watched_at, u.id
  `;
  for (const { montage_id, ...watcher } of rows) {
    const watchers = byMontage.get(montage_id) ?? [];
    watchers.push(watcher);
    byMontage.set(montage_id, watchers);
  }
  return byMontage;
}

/**
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check this route hangs on. Любой участник, зритель тоже: смотреть
 * ролики ему матрица даёт.
 */
export function montageWatchRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };

  app.post<{ Params: { memoryId: string; montageId: string } }>(
    "/memories/:memoryId/montages/:montageId/watched",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory } = request.membership;
      const { montageId } = request.params;
      // «Not a uuid» is «no such montage», for the reason `montages.ts` gives.
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);

      // Отмечается только готовый: смотреть у остальных нечего, а открытая
      // сборка — это журнал со своими смотрящими. Одним запросом, чтобы
      // проверка и отметка видели одну и ту же строку.
      const [montage] = await sql<Pick<Montage, "status">[]>`
        with target as (
          select id, status from montages where id = ${montageId} and memory_id = ${memory.id}
        ),
        seen as (
          insert into montage_watches (montage_id, user_id)
          select id, ${request.user.id} from target where status = 'ready'
          on conflict do nothing
        )
        select status from target
      `;
      if (!montage) return reply.code(404).send(notFound);
      if (montage.status !== "ready") {
        return reply.code(409).send({ error: "montage is not ready", status: montage.status });
      }
      return { ok: true };
    },
  );
}
