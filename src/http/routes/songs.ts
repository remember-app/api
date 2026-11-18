import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { deleteObjects, downloadUrl } from "../../integrations/storage/s3.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import { getMedia } from "../../services/media/queries.ts";
import {
  attachSong,
  createOwnSong,
  createSong,
  deleteOwnSong,
  detachSong,
  updateOwnSong,
} from "../../services/song/commands.ts";
import {
  getSong,
  listLibrarySongs,
  listOwnSongs,
  listProjectSongs,
} from "../../services/song/queries.ts";
import type { MediaId, ProjectId, SongId } from "../../types/id.ts";
import { fail } from "../errors.ts";

const createBody = {
  type: "object",
  required: ["name", "originalId"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    author: { type: ["string", "null"], minLength: 1, maxLength: 200 },
    originalId: { type: "string" },
    coverId: { type: ["string", "null"] },
    previewCoverId: { type: ["string", "null"] },
  },
} as const;

const updateBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    author: { type: ["string", "null"], minLength: 1, maxLength: 200 },
    coverId: { type: ["string", "null"] },
    previewCoverId: { type: ["string", "null"] },
  },
} as const;

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

type ProjectParams = { projectId: string };
type SongParams = { projectId: string; songId: string };
type OwnSongParams = { songId: string };

type CoverSong = { coverId: string | null; previewCoverId: string | null };

async function withCovers<T extends CoverSong>(items: T[], ttl: number) {
  return Promise.all(
    items.map(async (song) => {
      const [cover, previewCover] = await Promise.all([
        song.coverId ? getMedia(song.coverId as MediaId) : undefined,
        song.previewCoverId ? getMedia(song.previewCoverId as MediaId) : undefined,
      ]);
      return {
        ...song,
        coverUrl: cover ? await downloadUrl(cover.storageKey, ttl) : null,
        previewCoverUrl: previewCover ? await downloadUrl(previewCover.storageKey, ttl) : null,
      };
    }),
  );
}

export function songRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/songs/library",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request) => {
      const { limit, offset } = pageOf(request.query);
      const page = await listLibrarySongs(limit, offset);
      return { ...page, items: await withCovers(page.items, config.media.downloadTtlSeconds()) };
    },
  );

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/songs/mine",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request) => {
      const { limit, offset } = pageOf(request.query);
      const page = await listOwnSongs(request.authenticated!.user.id, limit, offset);
      return { ...page, items: await withCovers(page.items, config.media.downloadTtlSeconds()) };
    },
  );

  app.post<{
    Body: {
      name: string;
      author?: string | null;
      originalId: string;
      coverId?: string | null;
      previewCoverId?: string | null;
    };
  }>(
    "/songs",
    { schema: { body: createBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.body.originalId)) return fail(reply, 404, "not_found");
      if (request.body.coverId && !uuidPattern.test(request.body.coverId)) {
        return fail(reply, 404, "not_found");
      }
      if (request.body.previewCoverId && !uuidPattern.test(request.body.previewCoverId)) {
        return fail(reply, 404, "not_found");
      }
      const result = await createOwnSong(request.authenticated!.user.id, {
        name: request.body.name,
        author: request.body.author,
        originalId: request.body.originalId as MediaId,
        coverId: request.body.coverId as MediaId | null | undefined,
        previewCoverId: request.body.previewCoverId as MediaId | null | undefined,
      });
      if ("denial" in result) {
        if (result.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (result.denial === "bad_request") return fail(reply, 400, "bad_request");
        return fail(reply, 404, "not_found");
      }
      const [song] = await withCovers([result.song], config.media.downloadTtlSeconds());
      return song;
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
      return { ...page, items: await withCovers(page.items, config.media.downloadTtlSeconds()) };
    },
  );

  app.post<{
    Params: ProjectParams;
    Body: {
      name: string;
      author?: string | null;
      originalId: string;
      coverId?: string | null;
      previewCoverId?: string | null;
    };
  }>(
    "/projects/:projectId/songs",
    { schema: { body: createBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.projectId)) {
        return fail(reply, 404, "not_found");
      }
      if (!uuidPattern.test(request.body.originalId)) {
        return fail(reply, 404, "not_found");
      }
      if (request.body.coverId && !uuidPattern.test(request.body.coverId)) {
        return fail(reply, 404, "not_found");
      }
      if (request.body.previewCoverId && !uuidPattern.test(request.body.previewCoverId)) {
        return fail(reply, 404, "not_found");
      }
      const result = await createSong(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
        {
          name: request.body.name,
          author: request.body.author,
          originalId: request.body.originalId as MediaId,
          coverId: request.body.coverId as MediaId | null | undefined,
          previewCoverId: request.body.previewCoverId as MediaId | null | undefined,
        },
      );
      if ("denial" in result) {
        if (result.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (result.denial === "bad_request") return fail(reply, 400, "bad_request");
        return fail(reply, 404, "not_found");
      }
      const [song] = await withCovers([result.song], config.media.downloadTtlSeconds());
      return song;
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
      const media = await getMedia(song.originalId);
      if (!media) return fail(reply, 404, "not_found");
      const [signed] = await withCovers([song], config.media.downloadTtlSeconds());
      return {
        ...signed,
        url: await downloadUrl(media.storageKey, config.media.downloadTtlSeconds()),
      };
    },
  );

  app.patch<{
    Params: OwnSongParams;
    Body: {
      name?: string;
      author?: string | null;
      coverId?: string | null;
      previewCoverId?: string | null;
    };
  }>(
    "/songs/:songId",
    { schema: { body: updateBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.songId)) return fail(reply, 404, "not_found");
      if (request.body.coverId && !uuidPattern.test(request.body.coverId)) {
        return fail(reply, 404, "not_found");
      }
      if (request.body.previewCoverId && !uuidPattern.test(request.body.previewCoverId)) {
        return fail(reply, 404, "not_found");
      }
      const result = await updateOwnSong(
        request.params.songId as SongId,
        request.authenticated!.user.id,
        {
          name: request.body.name,
          author: request.body.author,
          coverId: request.body.coverId as MediaId | null | undefined,
          previewCoverId: request.body.previewCoverId as MediaId | null | undefined,
        },
      );
      if ("denial" in result) {
        if (result.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (result.denial === "bad_request") return fail(reply, 400, "bad_request");
        return fail(reply, 404, "not_found");
      }
      const [song] = await withCovers([result.song], config.media.downloadTtlSeconds());
      return song;
    },
  );

  app.post<{ Params: SongParams }>(
    "/projects/:projectId/songs/:songId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.projectId) || !uuidPattern.test(request.params.songId)) {
        return fail(reply, 404, "not_found");
      }
      const result = await attachSong(
        request.params.projectId as ProjectId,
        request.params.songId as SongId,
        request.authenticated!.user.id,
      );
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      const [song] = await withCovers([result.song], config.media.downloadTtlSeconds());
      return song;
    },
  );

  app.delete<{ Params: SongParams }>(
    "/projects/:projectId/songs/:songId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.projectId) || !uuidPattern.test(request.params.songId)) {
        return fail(reply, 404, "not_found");
      }
      const result = await detachSong(
        request.params.projectId as ProjectId,
        request.params.songId as SongId,
        request.authenticated!.user.id,
      );
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      return result;
    },
  );

  app.delete<{ Params: OwnSongParams }>(
    "/songs/:songId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.songId)) {
        return fail(reply, 404, "not_found");
      }
      const result = await deleteOwnSong(
        request.params.songId as SongId,
        request.authenticated!.user.id,
      );
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      if (result.keys.length > 0) await deleteObjects(result.keys);
      return { ok: true };
    },
  );
}
