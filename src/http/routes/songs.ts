import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { getMedia } from "../../domains/media/media.ts";
import { accessOf, isAdmin } from "../../domains/project/access.ts";
import {
  createSong,
  deleteSongWithMedia,
  getSong,
  listLibrarySongs,
  listProjectSongs,
} from "../../domains/song/song.ts";
import { deleteObjects, downloadUrl } from "../../integrations/storage/s3.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import type { ProjectId, SongId } from "../../types/id.ts";
import { fail } from "../errors.ts";

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
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/songs/library",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request) => {
      const { limit, offset } = pageOf(request.query);
      return listLibrarySongs(limit, offset);
    },
  );

  app.get<{ Params: ProjectParams; Querystring: { limit?: number; offset?: number } }>(
    "/projects/:projectId/songs",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.projectId)) {
        return fail(reply, 404, "not_found");
      }
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return fail(reply, 404, "not_found");
      const { limit, offset } = pageOf(request.query);
      return listProjectSongs(request.params.projectId as ProjectId, limit, offset);
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
        return fail(reply, 404, "not_found");
      }
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return fail(reply, 404, "not_found");
      if (!isAdmin(access)) return fail(reply, 403, "forbidden");
      if (!uuidPattern.test(request.body.mediaId)) {
        return fail(reply, 404, "not_found");
      }
      const media = await getMedia(request.body.mediaId as never);
      if (!media || media.kind !== "audio") {
        return fail(reply, 400, "bad_request");
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
        return fail(reply, 404, "not_found");
      }
      const song = await getSong(request.params.songId as SongId);
      if (!song) return fail(reply, 404, "not_found");
      const media = await getMedia(song.mediaId);
      if (!media) return fail(reply, 404, "not_found");
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
        return fail(reply, 404, "not_found");
      }
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return fail(reply, 404, "not_found");
      if (!isAdmin(access)) return fail(reply, 403, "forbidden");
      if (!uuidPattern.test(request.params.songId)) {
        return fail(reply, 404, "not_found");
      }
      const key = await deleteSongWithMedia(
        request.params.songId as SongId,
        request.params.projectId as ProjectId,
      );
      if (key === undefined) return fail(reply, 404, "not_found");
      await deleteObjects([key]);
      return { ok: true };
    },
  );
}
