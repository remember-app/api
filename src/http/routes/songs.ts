import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { getMedia } from "../../domains/media/media.ts";
import { accessOf, isAdmin } from "../../domains/project/access.ts";
import {
  createSong,
  deleteSong,
  getSong,
  listLibrarySongs,
  listProjectSongs,
} from "../../domains/song/song.ts";
import { downloadUrl } from "../../integrations/storage/s3.ts";
import type { ProjectId, SongId } from "../../types/id.ts";

const createBody = {
  type: "object",
  required: ["name", "author", "mediaId"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    author: { type: "string", minLength: 1, maxLength: 200 },
    mediaId: { type: "string" },
  },
} as const;

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

type ProjectParams = { projectId: string };
type SongParams = { projectId: string; songId: string };

export function songRoutes(app: FastifyInstance) {
  app.get("/songs/library", { preHandler: app.authenticate }, async () => {
    return listLibrarySongs();
  });

  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/songs",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.projectId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return reply.code(404).send({ error: "not_found" });
      return listProjectSongs(request.params.projectId as ProjectId);
    },
  );

  app.post<{
    Params: ProjectParams;
    Body: { name: string; author: string; mediaId: string };
  }>(
    "/projects/:projectId/songs",
    { schema: { body: createBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.projectId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!isAdmin(access)) return reply.code(403).send({ error: "forbidden" });
      if (!uuidPattern.test(request.body.mediaId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const media = await getMedia(request.body.mediaId as never);
      if (!media || media.kind !== "audio") {
        return reply.code(400).send({ error: "bad_request" });
      }
      return createSong({
        name: request.body.name,
        author: request.body.author,
        mediaId: media.id,
        projectId: request.params.projectId as ProjectId,
        uploadedBy: request.authenticated!.user.id,
      });
    },
  );

  app.get<{ Params: { songId: string } }>(
    "/songs/:songId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.songId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const song = await getSong(request.params.songId as SongId);
      if (!song) return reply.code(404).send({ error: "not_found" });
      const media = await getMedia(song.mediaId);
      if (!media) return reply.code(404).send({ error: "not_found" });
      return {
        ...song,
        url: await downloadUrl(media.storageKey, config.media.downloadTtlSeconds()),
      };
    },
  );

  app.delete<{ Params: SongParams }>(
    "/projects/:projectId/songs/:songId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.projectId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!isAdmin(access)) return reply.code(403).send({ error: "forbidden" });
      if (!uuidPattern.test(request.params.songId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const deleted = await deleteSong(
        request.params.songId as SongId,
        request.params.projectId as ProjectId,
      );
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );
}
