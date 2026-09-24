import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../auth/config.ts";
import { bearerToken, hashToken } from "../auth/session.ts";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";
import { notifyMontageReady } from "../memories/push.ts";

/**
 * The worker knocking: «this one is ready, tell them». Apart from the routes a
 * person calls (`montages.ts`) because nobody is behind this one — no session
 * to check, no membership, and a shared secret instead of both.
 */

/** The shared secret the worker knocks with; unset means nobody may knock. */
const workerToken = () => env("INTERNAL_WORKER_TOKEN");

/**
 * Read with the session check's own two helpers, so this route takes an
 * `Authorization` header by the same rule as every other one — `bearerToken`
 * is case-insensitive on the scheme because RFC 7235 is and clients do send
 * `bearer`, and a second parser here would 401 a worker the rest of the
 * service would have let in.
 *
 * Compared through a digest rather than with `===`: `hashToken` puts both
 * sides into 32-byte buffers whatever the lengths were, so `timingSafeEqual`
 * has nothing to bail out of early. A plain string compare leaks the secret's
 * prefix to whoever is willing to measure.
 */
function knockedWithTheSecret(header: string | undefined): boolean {
  const secret = workerToken();
  // No secret configured is not «let everyone in»: it is «this route is shut».
  if (!secret) return false;
  return timingSafeEqual(hashToken(bearerToken(header)), hashToken(secret));
}

/**
 * Mounted from `buildApp` beside the montage routes, and on neither check they
 * hang on.
 *
 * It carries no state: the worker has already written `ready`, `video_key`,
 * `poster_key` and `duration_seconds` into the row itself. All this does is
 * the one thing the worker cannot, which is reach the phones.
 */
export function montageReadyRoutes(app: FastifyInstance) {
  app.post<{ Params: { montageId: string } }>(
    "/internal/montages/:montageId/ready",
    async (request, reply) => {
      if (!knockedWithTheSecret(request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send({ error: "not found" });

      // The title is what the notification is about, so it is read here and not
      // in the sender — one query, and the join is also the check that the
      // montage exists at all.
      //
      // `ready` is in the WHERE for the reason it is in retry's UPDATE: this
      // route only knows how to say «ролик готов», so a row that is still
      // queued, still rendering or fell over has nothing for it to announce.
      // Without the clause a knock replayed — or aimed at any id at all by
      // whoever holds the secret — lights up every phone in the memory with a
      // link to a video that is not there.
      const [row] = await sql<{ memory_id: string; title: string }[]>`
        select m.memory_id, mem.title from montages m
        join memories mem on mem.id = m.memory_id
        where m.id = ${montageId} and m.status = 'ready'
      `;
      if (!row) return reply.code(404).send({ error: "not found" });

      await notifyMontageReady(request.log, { id: row.memory_id, title: row.title }, montageId);
      // `ok` however the sending went: the video is ready whether or not a
      // phone heard about it, and a worker told otherwise would retry a job
      // whose whole work is done (`notifyMontageReady` never throws).
      return { ok: true };
    },
  );
}
