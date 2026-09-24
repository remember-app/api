import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { downloadTtlSeconds, maxFileBytes, partBytes, uploadTtlSeconds } from "../media/config.ts";
import { dropKeys } from "../media/gallery.ts";
import {
  completeUpload,
  createUpload,
  downloadUrl,
  headSize,
  partUrls,
  storageConfigured,
  type UploadedPart,
} from "../media/r2.ts";
import { completeBody, partCount } from "../media/upload.ts";
import { uuidPattern } from "../memories/plugin.ts";

/**
 * «И возможность добавить свою» (doc-03): the organizer's own track, instead of
 * one off the worker's shelf. It goes into R2 exactly as material does — an
 * intent that hands out signed links, then «загружено» — and the montage order
 * names it afterwards by its key, in `music_tracks` beside the shelf ids: the
 * key is the only thing about the file the worker needs, since all it does
 * with a track is download it.
 *
 * A table of its own rather than a third `kind` in `media_items`, for the
 * reason the migration gives: a track is not the memory's material. The bytes
 * never touch the API here either — it only signs and records.
 *
 * The shelf's own five are here too, at the bottom: «Послушать» signs a link to
 * one of them. Same music, same store, opposite direction — and no memory in
 * the path, because that shelf belongs to nobody in particular.
 *
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check these routes hang on.
 */

/**
 * The tracks the worker has, by id, in the order the app shows them
 * (`design/screens/MontageMusic.html`: Яркая, Тёплая, Спокойная, Ночь,
 * Дорога). To refuse an id it does not hold, and — exported — to weigh the
 * `music_tracks` of an order against the same list (`order.ts`). The files
 * themselves are the worker's, one per id, listed with their licences in
 * `projects/montage/tracks/README.md` — and the list is short enough that a
 * table for it would be a table for five strings. It is the worker's shelf that
 * decides what belongs here: when that shelf grew from three synthesized tones
 * to five real tracks, an order for `night` or `road` was refused by this
 * service alone.
 */
export const musicTracks = ["bright", "warm", "calm", "night", "road"] as const;

/** A `music_uploads` row. `size_bytes` is a string for `media_items`'s reason. */
export type MusicUpload = {
  id: string;
  memory_id: string;
  uploaded_by: string;
  status: "pending_upload" | "ready";
  object_key: string;
  upload_id: string | null;
  size_bytes: string;
  created_at: Date;
  updated_at: Date;
};

const intentBody = {
  type: "object",
  required: ["size_bytes"],
  additionalProperties: false,
  properties: {
    // The declared size, which is what the ceiling is checked against before a
    // byte is accepted and what the number of parts is cut from. What is
    // recorded afterwards is what R2 measured.
    size_bytes: { type: "integer", minimum: 1 },
  },
} as const;

export function musicRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const unconfigured = { error: "storage not configured" };

  // «Свой трек» — the organizer's, and nobody else's: the track is a preference
  // about the video, and only the organizer orders one (architecture.md,
  // «Проверка прав»). A non-member never reaches this line — the membership
  // check answered them 404.
  app.post<{ Params: { memoryId: string }; Body: { size_bytes: number } }>(
    "/memories/:memoryId/music",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: intentBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });
      if (!storageConfigured()) return reply.code(503).send(unconfigured);

      const { size_bytes } = request.body;
      // One ceiling, the media one, rather than a knob of its own: a track is a
      // file like any other, and a second limit to keep in step with the first
      // would be a limit nobody asked for.
      if (size_bytes > maxFileBytes()) {
        return reply.code(413).send({ error: "file is too large", limit_bytes: maxFileBytes() });
      }
      // ponytail: a track is deliberately outside the memory's `storage_bytes`
      // and `media_count` — those count the gallery, and nothing here can put a
      // track back to release them, since a track is never deleted. One track
      // per order from the one person who may order is not a leak worth a
      // ledger; give tracks their own accounting if that ever stops being true.

      // The id is minted here because the key is made of it, exactly as
      // `media_items` mints one: the row must carry the key it was signed with.
      const id = randomUUID();
      const key = `music/${id}`;
      // The multipart before the row, which is the opposite of the media
      // intent's order — and for the reason the media one has no counterpart
      // here: there it is a second link request that may resume the upload, so
      // a row with no upload is still useful. There is no re-issue of these
      // links (a track is small and the hour is long), so a row with no upload
      // would be a row nobody could ever finish.
      const uploadId = await createUpload(key);
      const [track] = await sql<MusicUpload[]>`
        insert into music_uploads (id, memory_id, uploaded_by, object_key, upload_id, size_bytes)
        values (${id}, ${memory.id}, ${request.user.id}, ${key}, ${uploadId}, ${size_bytes})
        returning *
      `;
      if (!track) throw new Error("insert into music_uploads returned no row");

      const ttl = uploadTtlSeconds();
      const parts = partCount(size_bytes);
      return reply.code(201).send({
        id: track.id,
        status: track.status,
        upload: {
          key,
          upload_id: uploadId,
          part_size: partBytes(),
          parts: (await partUrls(key, uploadId, parts, ttl)).map((url, index) => ({
            part_number: index + 1,
            url,
          })),
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        },
      });
    },
  );

  // «Загружено». Seals the object, marks the track ready and answers with the
  // key the order will name it by — and says the same thing however many times
  // it is called.
  app.post<{
    Params: { memoryId: string; trackId: string };
    Body: { parts: UploadedPart[] };
  }>(
    "/memories/:memoryId/music/:trackId/complete",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: completeBody } },
    async (request, reply) => {
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const { memory } = request.membership;
      const { trackId } = request.params;
      // «Not a uuid» is «no such track», the house rule of everything behind the
      // membership check (docs/auth.md, «404 один на всех»), and not a params schema
      // for the reason the media routes give: a schema answers before the
      // membership check has run, from outside the memory.
      if (!uuidPattern.test(trackId)) return reply.code(404).send(notFound);

      // Ownership and not role, as the media callback checks it: only the
      // person who started an upload can finish it.
      const [track] = await sql<MusicUpload[]>`
        select * from music_uploads
        where id = ${trackId} and memory_id = ${memory.id} and uploaded_by = ${request.user.id}
      `;
      if (!track) return reply.code(404).send(notFound);
      // The repeat callback, which is the ordinary case for a phone that lost
      // the answer to the first one.
      if (track.status === "ready") {
        return { id: track.id, status: track.status, key: track.object_key };
      }
      if (!track.upload_id) return reply.code(409).send({ error: "upload was never started" });

      // Not fatal on its own: two callbacks racing means the second finds the
      // upload already sealed. The HEAD below is the actual answer to «are the
      // bytes there», so this only has to be attempted.
      try {
        await completeUpload(track.object_key, track.upload_id, request.body.parts);
      } catch (error) {
        request.log.warn({ err: error, track: track.id }, "completing the upload failed");
      }

      const size = await headSize(track.object_key);
      if (size === null) return reply.code(409).send({ error: "the upload is not in storage" });
      // The ceiling again, and this time against the only number that is not the
      // client's: a presigned part carries no length of its own, so a file
      // announced as one byte could arrive a gigabyte long. Refused, the record
      // and the object both go — exactly as a refusal at intent leaves neither.
      if (size > maxFileBytes()) {
        await sql`delete from music_uploads where id = ${track.id} and status = 'pending_upload'`;
        await dropKeys(request.log, { keys: [track.object_key], uploads: [] });
        request.log.warn(
          { track: track.id, declared: track.size_bytes, measured: size },
          "a track arrived larger than it was declared and was refused",
        );
        return reply.code(413).send({ error: "file is too large", limit_bytes: maxFileBytes() });
      }

      // The status in the WHERE and not only in the read above: two callbacks
      // racing must both answer «ready», and it costs one statement to make
      // that true rather than two.
      await sql`
        update music_uploads set status = 'ready', size_bytes = ${size}, updated_at = now()
        where id = ${track.id} and status = 'pending_upload'
      `;
      return { id: track.id, status: "ready", key: track.object_key };
    },
  );

  // «Послушать» on «Под что монтировать» (`design/screens/MontageMusic.html`):
  // the track before the video is ordered. Behind `app.authenticate` alone and
  // outside `/memories/:memoryId` — the library is one shelf for the whole
  // product, the same five for everyone, so there is no membership to check and
  // no role to weigh. The worker lays the files out under `tracks/<id>.mp3`
  // (`python -m montage tracks`); signing a link to one is all of this route.
  app.get<{ Params: { trackId: string } }>(
    "/music/tracks/:trackId",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const { trackId } = request.params;
      // Checked against the very list an order is checked against, so «послушать»
      // and «заказать» can never disagree about which tracks exist. A params
      // schema with an `enum` would answer `400`, and a track that is not on the
      // shelf is a thing that is not there — `404`, as everywhere else here.
      if (!musicTracks.some((id) => id === trackId)) return reply.code(404).send(notFound);
      return { url: await downloadUrl(`tracks/${trackId}.mp3`, downloadTtlSeconds()) };
    },
  );
}
