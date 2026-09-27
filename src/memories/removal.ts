import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { dropKeys, removeMedia } from "../media/gallery.ts";
import { removeMontages } from "../montages/montages.ts";

/**
 * «Удалить воспоминание» — the one act that takes a whole memory down (doc-01,
 * 2026-09-24). Its own file, next to the plugin that owns the row: what is
 * written here is not about a memory's fields but about everything hanging off
 * them, and it reaches into media, montages and music to say so.
 *
 * The rule the whole route follows: the database takes the rows, this takes
 * everything the database cannot see — the objects in the bucket, the worker's
 * own tables, and the queue. Members, invites, labels, montages and their
 * journals all cascade off `memories` (migrations 003…130) and are deliberately
 * not deleted by hand here: a list written out in a route is a list that
 * forgets the next table somebody adds.
 */
export function memoryRemovalRoutes(app: FastifyInstance) {
  app.delete<{ Params: { memoryId: string } }>(
    "/memories/:memoryId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      // A member of another standing, not a stranger: the membership check
      // already answered a stranger with the house 404. Only the organizer —
      // a memory is deleted by the one person who cannot leave it (doc-01).
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });

      const left = await sql.begin(async (tx) => {
        // Everything anybody brought here, through the one statement a single
        // frame and a departure also go through. The memory's own counters are
        // moved for nothing on the way — the row carrying them is gone a
        // moment later — and a branch to skip that would cost more than it.
        const media = await removeMedia(tx, memory.id, "everything");

        // The assembled videos, through the statement «Удалить ролик» goes
        // through. Deleted by hand and not by the cascade below only because
        // the cascade cannot hand back what to take out of the bucket; the rows
        // would go either way.
        const montages = await removeMontages(tx, memory.id, "everything");

        // Свои треки организатора. Счётчиков они не двигали (`music.ts`), так
        // что от них остаётся ровно то, что лежит в хранилище: ключ и, у
        // недокачанного, незакрытая multipart-загрузка — ровно то же деление,
        // что у медиа.
        const music = await tx<{ object_key: string; status: string; upload_id: string | null }[]>`
          delete from music_uploads where memory_id = ${memory.id}
          returning object_key, status, upload_id
        `;

        await tx`delete from memories where id = ${memory.id}`;

        return {
          keys: [...media.keys, ...montages.keys, ...music.map((row) => row.object_key)],
          uploads: [
            ...media.uploads,
            ...music.flatMap((row) =>
              row.status === "pending_upload" && row.upload_id !== null
                ? [{ key: row.object_key, uploadId: row.upload_id }]
                : [],
            ),
          ],
        };
      });

      // Outside the transaction, and best effort — see `dropKeys`. The memory
      // is gone for everybody the moment the commit lands; bytes nobody can
      // name any more cost storage and nothing else.
      await dropKeys(request.log, left);
      return { ok: true };
    },
  );
}
