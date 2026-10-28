import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";

/**
 * «Проанализировать» — the organizer asks the automatic screening to look at
 * this memory's material now (doc-03), rather than wait for the worker to get
 * to it on its own.
 *
 * api does not analyse anything: it puts one `media_analysis` job in the queue,
 * with the memory's id as its `ref`, and the worker in `projects/montage`
 * writes the verdict onto each frame — `screening_rejected` and
 * `screening_reason`, the fields the gallery already hands out. The queue
 * belongs to montage; that type and what `ref` means are the whole contract
 * between the two (docs/media.md).
 */
export function screeningRoutes(app: FastifyInstance) {
  app.post<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/analyze",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      // The organizer's alone, as ordering a montage is: the screening is a
      // proposal they correct before that order, and nobody else's to spend
      // the worker's time on.
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });

      const [job] = await sql.begin(async (tx) => {
        // Two taps race, and the queue has no unique key for this pair. The
        // lock is what keeps the second caller from finding nothing while the
        // first is about to insert; it is held per memory and released with
        // the transaction.
        await tx`select pg_advisory_xact_lock(hashtext(${`media_analysis:${memory.id}`}))`;

        // The insert and the answer about the job it found are one statement,
        // so one snapshot. Read in two, the worker could finish the job in
        // between and the second read would find nothing to answer with.
        return await tx<{ status: string }[]>`
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

      // 202 either way — the analysis is underway — and the body says whether
      // it still waits for the worker or has started.
      return reply.code(202).send({ status: job.status });
    },
  );
}
