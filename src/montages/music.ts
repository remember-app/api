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
export const musicTracks = [
  "bright",
  "warm",
  "calm",
  "night",
  "road",
  "merry",
  "tender",
  "dreamy",
  "mystery",
  "energetic",
] as const;
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
    size_bytes: { type: "integer", minimum: 1 },
  },
} as const;
export function musicRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const unconfigured = { error: "storage not configured" };
  app.post<{
    Params: {
      memoryId: string;
    };
    Body: {
      size_bytes: number;
    };
  }>(
    "/memories/:memoryId/music",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: intentBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const { size_bytes } = request.body;
      if (size_bytes > maxFileBytes()) {
        return reply.code(413).send({ error: "file is too large", limit_bytes: maxFileBytes() });
      }
      const id = randomUUID();
      const key = `music/${id}`;
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
  app.post<{
    Params: {
      memoryId: string;
      trackId: string;
    };
    Body: {
      parts: UploadedPart[];
    };
  }>(
    "/memories/:memoryId/music/:trackId/complete",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: completeBody } },
    async (request, reply) => {
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const { memory } = request.membership;
      const { trackId } = request.params;
      if (!uuidPattern.test(trackId)) return reply.code(404).send(notFound);
      const [track] = await sql<MusicUpload[]>`
        select * from music_uploads
        where id = ${trackId} and memory_id = ${memory.id} and uploaded_by = ${request.user.id}
      `;
      if (!track) return reply.code(404).send(notFound);
      if (track.status === "ready") {
        return { id: track.id, status: track.status, key: track.object_key };
      }
      if (!track.upload_id) return reply.code(409).send({ error: "upload was never started" });
      try {
        await completeUpload(track.object_key, track.upload_id, request.body.parts);
      } catch (error) {
        request.log.warn({ err: error, track: track.id }, "completing the upload failed");
      }
      const size = await headSize(track.object_key);
      if (size === null) return reply.code(409).send({ error: "the upload is not in storage" });
      if (size > maxFileBytes()) {
        await sql`delete from music_uploads where id = ${track.id} and status = 'pending_upload'`;
        await dropKeys(request.log, { keys: [track.object_key], uploads: [] });
        request.log.warn(
          { track: track.id, declared: track.size_bytes, measured: size },
          "a track arrived larger than it was declared and was refused",
        );
        return reply.code(413).send({ error: "file is too large", limit_bytes: maxFileBytes() });
      }
      await sql`
        update music_uploads set status = 'ready', size_bytes = ${size}, updated_at = now()
        where id = ${track.id} and status = 'pending_upload'
      `;
      return { id: track.id, status: "ready", key: track.object_key };
    },
  );
  app.get<{
    Params: {
      trackId: string;
    };
  }>("/music/tracks/:trackId", { preHandler: [app.authenticate] }, async (request, reply) => {
    if (!storageConfigured()) return reply.code(503).send(unconfigured);
    const { trackId } = request.params;
    if (!musicTracks.some((id) => id === trackId)) return reply.code(404).send(notFound);
    return { url: await downloadUrl(`tracks/${trackId}.mp3`, downloadTtlSeconds()) };
  });
}
