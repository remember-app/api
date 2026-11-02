import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { dropKeys, removeMedia } from "../media/gallery.ts";
import { removeMontages } from "../montages/montages.ts";
export function memoryRemovalRoutes(app: FastifyInstance) {
  app.delete<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });
      const left = await sql.begin(async (tx) => {
        const media = await removeMedia(tx, memory.id, "everything");
        const montages = await removeMontages(tx, memory.id, "everything");
        const music = await tx<
          {
            object_key: string;
            status: string;
            upload_id: string | null;
          }[]
        >`
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
      await dropKeys(request.log, left);
      return { ok: true };
    },
  );
}
