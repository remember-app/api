import type { FastifyInstance } from "fastify";
import type { PublicUser } from "../auth/identity.ts";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";
import type { Montage } from "./row.ts";
export async function watchersOf(memoryId: string, montageIds: string[]) {
  const byMontage = new Map<string, PublicUser[]>();
  if (montageIds.length === 0) return byMontage;
  const rows = await sql<
    ({
      montage_id: string;
    } & PublicUser)[]
  >`
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
export function montageWatchRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  app.post<{
    Params: {
      memoryId: string;
      montageId: string;
    };
  }>(
    "/memories/:memoryId/montages/:montageId/watched",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory } = request.membership;
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);
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
