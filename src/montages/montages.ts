import type { FastifyInstance } from "fastify";
import type { TransactionSql } from "postgres";
import { sql } from "../db.ts";
import { downloadTtlSeconds } from "../media/config.ts";
import { dropKeys } from "../media/gallery.ts";
import { storageConfigured } from "../media/r2.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { stagesFor } from "./journal.ts";
import { checkOrder, nameField, nameOf, type OrderBody, orderBodySchema } from "./order.ts";
import { queueFor } from "./queue.ts";
import type { Montage } from "./row.ts";
import { orderSummary } from "./summary.ts";
import { type ViewRow, view, viewColumns } from "./view.ts";
import { watchersOf } from "./watched.ts";
export async function removeMontages(
  tx: TransactionSql,
  memoryId: string,
  target:
    | {
        montageId: string;
      }
    | "everything",
) {
  const montageId = target === "everything" ? null : target.montageId;
  const gone = await tx<
    {
      video_key: string | null;
      poster_key: string | null;
    }[]
  >`
    with gone as (
      delete from montages
      where memory_id = ${memoryId} and (${montageId}::uuid is null or id = ${montageId}::uuid)
      returning id, video_key, poster_key
    ),
    -- Сборка, до которой очередь ещё не дошла, отменяется здесь же: её ролика
    -- больше нет, и работа над ним была бы работой в пустоту. Ту, что уже идёт,
    -- отменить некому — воркер дописывает ролик и, не найдя строки, сам
    -- убирает из хранилища то, что залил (montage video/montage.py, «went away
    -- mid-assembly»).
    queued as (
      delete from jobs where ref in (select id::text from gone)
    ),
    counted as (
      update memories set montage_count = montage_count - (select count(*) from gone)::int
      where id = ${memoryId} and exists (select 1 from gone)
    )
    select video_key, poster_key from gone
  `;
  return {
    removed: gone.length,
    keys: gone
      .flatMap((row) => [row.video_key, row.poster_key])
      .filter((key): key is string => key !== null),
  };
}
export function montageRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const forbidden = { error: "forbidden" };
  const orderBody = orderBodySchema();
  const renameBody = {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: { name: nameField },
  } as const;
  app.post<{
    Params: {
      memoryId: string;
    };
    Body: OrderBody;
  }>(
    "/memories/:memoryId/montages",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: orderBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);
      const checked = await checkOrder(memory.id, request.body);
      if (!("params" in checked)) return reply.code(checked.code).send(checked.body);
      const { params } = checked;
      const montage = await sql.begin(async (tx) => {
        const [row] = await tx<ViewRow[]>`
          with m as (
            insert into montages (memory_id, ordered_by, params, name, template, photos, videos)
            values (${memory.id}, ${request.user.id}, ${sql.json(params)},
              ${nameOf(request.body?.name)}, ${request.body?.template ?? null},
              ${checked.left.photos}, ${checked.left.videos})
            returning *
          )
          select ${viewColumns} from m join users u on u.id = m.ordered_by
        `;
        if (!row) throw new Error("insert into montages returned no row");
        await tx`insert into jobs (type, ref) values ('montage', ${row.id})`;
        await tx`
          update memories set montage_count = montage_count + 1 where id = ${memory.id}
        `;
        await tx`
          insert into user_usage (user_id, montage_count)
          values (${request.user.id}, 1)
          on conflict (user_id) do update set
            montage_count = user_usage.montage_count + 1,
            updated_at = now()
        `;
        return row;
      });
      return reply.code(201).send(await view(montage, downloadTtlSeconds(), request.user.language));
    },
  );
  app.post<{
    Params: {
      memoryId: string;
    };
    Body: OrderBody;
  }>(
    "/memories/:memoryId/montages/preview",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: orderBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);
      const checked = await checkOrder(memory.id, request.body);
      if (!("params" in checked)) return reply.code(checked.code).send(checked.body);
      return orderSummary(checked);
    },
  );
  app.get<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId/montages",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!storageConfigured()) {
        return reply.code(503).send({ error: "storage not configured" });
      }
      const montages = await sql<ViewRow[]>`
        select ${viewColumns} from montages m join users u on u.id = m.ordered_by
        where m.memory_id = ${request.membership.memory.id}
        order by m.created_at desc, m.id desc
      `;
      const ids = (keep: (m: ViewRow) => boolean) => montages.filter(keep).map((m) => m.id);
      const [progress, watched, queue] = await Promise.all([
        stagesFor(ids((m) => m.status !== "ready")),
        watchersOf(
          request.membership.memory.id,
          ids((m) => m.status === "ready"),
        ),
        queueFor(ids((m) => m.status === "queued")),
      ]);
      const ttl = downloadTtlSeconds();
      return Promise.all(
        montages.map(async (montage) => ({
          ...(await view(montage, ttl, request.user.language)),
          stages: progress.get(montage.id) ?? null,
          queue: queue.get(montage.id) ?? null,
          watched_by: watched.get(montage.id) ?? [],
        })),
      );
    },
  );
  app.post<{
    Params: {
      memoryId: string;
      montageId: string;
    };
  }>(
    "/memories/:memoryId/montages/:montageId/retry",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);
      const requeued = await sql.begin(async (tx) => {
        const [row] = await tx<ViewRow[]>`
          update montages m set status = 'queued', error_text = null, updated_at = now()
          from users u
          where m.id = ${montageId} and m.memory_id = ${memory.id} and m.status = 'failed'
            and u.id = m.ordered_by
          returning ${viewColumns}
        `;
        if (!row) return undefined;
        await tx`delete from montage_journal_entries where montage_id = ${row.id}`;
        await tx`delete from montage_stages where montage_id = ${row.id}`;
        await tx`insert into jobs (type, ref) values ('montage', ${row.id})`;
        return row;
      });
      if (requeued) return view(requeued, downloadTtlSeconds(), request.user.language);
      const [current] = await sql<Pick<Montage, "status">[]>`
        select status from montages where id = ${montageId} and memory_id = ${memory.id}
      `;
      if (!current) return reply.code(404).send(notFound);
      return reply.code(409).send({ error: "montage has not failed", status: current.status });
    },
  );
  app.patch<{
    Params: {
      memoryId: string;
      montageId: string;
    };
    Body: {
      name: string;
    };
  }>(
    "/memories/:memoryId/montages/:montageId",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: renameBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);
      const [row] = await sql<ViewRow[]>`
        update montages m set name = ${nameOf(request.body.name)}, updated_at = now()
        from users u
        where m.id = ${montageId} and m.memory_id = ${memory.id} and u.id = m.ordered_by
        returning ${viewColumns}
      `;
      if (!row) return reply.code(404).send(notFound);
      return view(row, downloadTtlSeconds(), request.user.language);
    },
  );
  app.delete<{
    Params: {
      memoryId: string;
      montageId: string;
    };
  }>(
    "/memories/:memoryId/montages/:montageId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send(forbidden);
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);
      const { removed, keys } = await sql.begin((tx) =>
        removeMontages(tx, memory.id, { montageId }),
      );
      if (removed === 0) return reply.code(404).send(notFound);
      await dropKeys(request.log, { keys, uploads: [] });
      return { ok: true };
    },
  );
}
