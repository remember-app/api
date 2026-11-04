import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { deleteObjects, downloadUrl } from "../../integrations/storage/s3.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import { getMedia } from "../../services/media/queries.ts";
import {
  deleteMovieWithMedia,
  getMovie,
  listMovies,
  renameMovie,
} from "../../services/movie/movie.ts";
import { accessOf, isAdmin } from "../../services/project/access.ts";
import type { MovieId, ProjectId } from "../../types/id.ts";
import { fail } from "../errors.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

type ProjectParams = { projectId: string };
type MovieParams = { projectId: string; movieId: string };

const renameBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

async function view(movieId: MovieId, ttl: number) {
  const movie = await getMovie(movieId);
  if (!movie) return undefined;
  const video = await getMedia(movie.videoId);
  const thumbnail = movie.derived.thumbnailId
    ? await getMedia(movie.derived.thumbnailId)
    : undefined;
  const preview = movie.derived.previewId ? await getMedia(movie.derived.previewId) : undefined;
  return {
    ...movie,
    video_url: video ? await downloadUrl(video.storageKey, ttl) : null,
    poster_url: thumbnail ? await downloadUrl(thumbnail.storageKey, ttl) : null,
    preview_url: preview ? await downloadUrl(preview.storageKey, ttl) : null,
  };
}

export function movieRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams; Querystring: { limit?: number; offset?: number } }>(
    "/projects/:projectId/movies",
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
      const ttl = config.media.downloadTtlSeconds();
      const { limit, offset } = pageOf(request.query);
      const found = await listMovies(request.params.projectId as ProjectId, limit, offset);
      const items = await Promise.all(found.items.map((movie) => view(movie.id, ttl)));
      return { items, nextOffset: found.nextOffset };
    },
  );

  app.get<{ Params: MovieParams }>(
    "/projects/:projectId/movies/:movieId",
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
      if (!uuidPattern.test(request.params.movieId)) {
        return fail(reply, 404, "not_found");
      }
      const movie = await getMovie(request.params.movieId as MovieId);
      if (!movie || movie.projectId !== request.params.projectId) {
        return fail(reply, 404, "not_found");
      }
      return view(movie.id, config.media.downloadTtlSeconds());
    },
  );

  app.patch<{ Params: MovieParams; Body: { name: string } }>(
    "/projects/:projectId/movies/:movieId",
    { schema: { body: renameBody }, preHandler: app.authenticate },
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
      if (!uuidPattern.test(request.params.movieId)) {
        return fail(reply, 404, "not_found");
      }
      const movie = await renameMovie(
        request.params.movieId as MovieId,
        request.params.projectId as ProjectId,
        request.body.name,
      );
      if (!movie) return fail(reply, 404, "not_found");
      return view(movie.id, config.media.downloadTtlSeconds());
    },
  );

  app.delete<{ Params: MovieParams }>(
    "/projects/:projectId/movies/:movieId",
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
      if (!uuidPattern.test(request.params.movieId)) {
        return fail(reply, 404, "not_found");
      }
      const keys = await deleteMovieWithMedia(
        request.params.movieId as MovieId,
        request.params.projectId as ProjectId,
      );
      if (!keys) return fail(reply, 404, "not_found");
      if (keys.length > 0) await deleteObjects(keys);
      return { ok: true };
    },
  );
}
