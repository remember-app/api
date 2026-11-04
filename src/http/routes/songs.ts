import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { deleteObjects, downloadUrl } from "../../integrations/storage/s3.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import { getMedia } from "../../services/media/queries.ts";
import { createSong, deleteSongWithMedia } from "../../services/song/commands.ts";
import { getSong, listLibrarySongs, listProjectSongs } from "../../services/song/queries.ts";
import type { MediaId, ProjectId, SongId } from "../../types/id.ts";
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
      const { limit, offset } = pageOf(request.query);
      const page = await listProjectSongs(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
        limit,
        offset,
      );
      if (!page) return fail(reply, 404, "not_found");
      return page;
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
      if (!uuidPattern.test(request.body.mediaId)) {
        return fail(reply, 404, "not_found");
      }
      const result = await createSong(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
        {
          name: request.body.name,
          author: request.body.author,
          mediaId: request.body.mediaId as MediaId,
        },
      );
      if ("denial" in result) {
        if (result.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (result.denial === "bad_request") return fail(reply, 400, "bad_request");
        return fail(reply, 404, "not_found");
      }
      return result.song;
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
      if (!uuidPattern.test(request.params.projectId) || !uuidPattern.test(request.params.songId)) {
        return fail(reply, 404, "not_found");
      }
      const result = await deleteSongWithMedia(
        request.params.projectId as ProjectId,
        request.params.songId as SongId,
        request.authenticated!.user.id,
      );
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      if (result.key === undefined) return fail(reply, 404, "not_found");
      await deleteObjects([result.key]);
      return { ok: true };
    },
  );
}
