import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
export function screeningRoutes(app: FastifyInstance) {
  app.post<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId/analyze",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });
      const [job] = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`media_analysis:${memory.id}`}))`;
        return await tx<
          {
            status: string;
          }[]
        >`
          with placed as (
            insert into jobs (type, ref)
            select 'media_analysis', ${memory.id}
            where not exists (
              select 1 from jobs
              where type = 'media_analysis' and ref = ${memory.id}
                and status in ('queued', 'running')
            )
            returning status
          )
          select status from placed
          union all
          select status from jobs
          where type = 'media_analysis' and ref = ${memory.id}
            and status in ('queued', 'running')
        `;
      });
      if (!job) throw new Error("media_analysis job is gone after the queue said it was there");
      return reply.code(202).send({ status: job.status });
    },
  );
}
