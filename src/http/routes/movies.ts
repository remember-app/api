import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { deleteMedia, getMedia } from "../../domains/media/media.ts";
import { deleteMovie, getMovie, listMovies, renameMovie } from "../../domains/movie/movie.ts";
import { accessOf, isAdmin } from "../../domains/project/access.ts";
import { deleteObjects, downloadUrl } from "../../integrations/storage/s3.ts";
import type { MediaId, MovieId, ProjectId } from "../../types/id.ts";

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
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/movies",
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
      const ttl = config.media.downloadTtlSeconds();
      const movies = await listMovies(request.params.projectId as ProjectId);
      return Promise.all(movies.map((movie) => view(movie.id, ttl)));
    },
  );

  app.get<{ Params: MovieParams }>(
    "/projects/:projectId/movies/:movieId",
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
      if (!uuidPattern.test(request.params.movieId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const movie = await getMovie(request.params.movieId as MovieId);
      if (!movie || movie.projectId !== request.params.projectId) {
        return reply.code(404).send({ error: "not_found" });
      }
      return view(movie.id, config.media.downloadTtlSeconds());
    },
  );

  app.patch<{ Params: MovieParams; Body: { name: string } }>(
    "/projects/:projectId/movies/:movieId",
    { schema: { body: renameBody }, preHandler: app.authenticate },
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
      if (!uuidPattern.test(request.params.movieId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const movie = await renameMovie(
        request.params.movieId as MovieId,
        request.params.projectId as ProjectId,
        request.body.name,
      );
      if (!movie) return reply.code(404).send({ error: "not_found" });
      return view(movie.id, config.media.downloadTtlSeconds());
    },
  );

  app.delete<{ Params: MovieParams }>(
    "/projects/:projectId/movies/:movieId",
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
      if (!uuidPattern.test(request.params.movieId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const deleted = await deleteMovie(
        request.params.movieId as MovieId,
        request.params.projectId as ProjectId,
      );
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      const ids = [deleted.videoId, deleted.thumbnailId, deleted.previewId].filter(
        (id): id is MediaId => id !== null,
      );
      const keys: string[] = [];
      for (const id of ids) {
        const key = await deleteMedia(id);
        if (key) keys.push(key);
      }
      if (keys.length > 0) await deleteObjects(keys);
      return { ok: true };
    },
  );
}
