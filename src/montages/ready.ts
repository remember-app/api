import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../auth/config.ts";
import { bearerToken, hashToken } from "../auth/session.ts";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { notifyMontageReady } from "../memories/push.ts";

const workerToken = () => env("INTERNAL_WORKER_TOKEN");
function knockedWithTheSecret(header: string | undefined): boolean {
  const secret = workerToken();
  if (!secret) return false;
  return timingSafeEqual(hashToken(bearerToken(header)), hashToken(secret));
}
export function montageReadyRoutes(app: FastifyInstance) {
  app.post<{
    Params: {
      montageId: string;
    };
  }>("/internal/montages/:montageId/ready", async (request, reply) => {
    if (!knockedWithTheSecret(request.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { montageId } = request.params;
    if (!uuidPattern.test(montageId)) return reply.code(404).send({ error: "not found" });
    const [row] = await sql<
      {
        memory_id: string;
        title: string;
      }[]
    >`
        select m.memory_id, mem.title from montages m
        join memories mem on mem.id = m.memory_id
        where m.id = ${montageId} and m.status = 'ready'
      `;
    if (!row) return reply.code(404).send({ error: "not found" });
    await notifyMontageReady(request.log, { id: row.memory_id, title: row.title }, montageId);
    return { ok: true };
  });
}
