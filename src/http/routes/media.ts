import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.ts";
import { deleteObjects, downloadUrl } from "../../integrations/storage/s3.ts";
import { cursorQuerySchema, decodeCursor, limitOf } from "../../pagination.ts";
import { type MediaPatch, removeMedia, updateMedia } from "../../services/media/commands.ts";
import {
  downloadLinks,
  galleryPage,
  getMedia,
  itemView,
  mediaView,
} from "../../services/media/queries.ts";
import { accessOf } from "../../services/project/access.ts";
import { updateItemDescription } from "../../services/project/item/commands.ts";
import { getItemByMedia } from "../../services/project/item/queries.ts";
import type { MediaId, ProjectId, ProjectItemId } from "../../types/id.ts";
import { fail } from "../errors.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

type ProjectParams = { projectId: string };
type MediaParams = { projectId: string; mediaId: string };
type ItemParams = { projectId: string; itemId: string };

const itemBody = {
  type: "object",
  required: ["description"],
  additionalProperties: false,
  properties: { description: { type: ["string", "null"], maxLength: 4000 } },
} as const;

const mediaBody = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  dependencies: { latitude: ["longitude"], longitude: ["latitude"] },
  properties: {
    capturedAt: { type: ["string", "null"], format: "date-time" },
    latitude: { type: ["number", "null"], minimum: -90, maximum: 90 },
    longitude: { type: ["number", "null"], minimum: -180, maximum: 180 },
  },
} as const;

const downloadBody = {
  type: "object",
  required: ["itemIds"],
  additionalProperties: false,
  properties: {
    itemIds: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      uniqueItems: true,
      items: { type: "string" },
    },
  },
} as const;

async function accessOr404(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  const projectId = request.params.projectId;
  if (!uuidPattern.test(projectId)) {
    await fail(reply, 404, "not_found");
    return undefined;
  }
  const access = await accessOf(projectId as ProjectId, request.authenticated!.user.id);
  if (!access) {
    await fail(reply, 404, "not_found");
    return undefined;
  }
  return access;
}

export function mediaRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams; Querystring: { limit?: number; cursor?: string } }>(
    "/projects/:projectId/gallery",
    { schema: { querystring: cursorQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId;
      if (!uuidPattern.test(projectId)) return fail(reply, 404, "not_found");
      const cursor = request.query.cursor;
      const after = cursor ? (decodeCursor(cursor) ?? null) : null;
      if (cursor && !after) return fail(reply, 400, "bad_request");
      const page = await galleryPage(
        projectId as ProjectId,
        request.authenticated!.user.id,
        limitOf(request.query.limit),
        after,
      );
      if (!page) return fail(reply, 404, "not_found");
      return page;
    },
  );

  app.get<{ Params: ItemParams }>(
    "/projects/:projectId/items/:itemId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId;
      const itemId = request.params.itemId;
      if (!uuidPattern.test(projectId) || !uuidPattern.test(itemId)) {
        return fail(reply, 404, "not_found");
      }
      const view = await itemView(
        projectId as ProjectId,
        itemId as ProjectItemId,
        request.authenticated!.user.id,
      );
      if (!view) return fail(reply, 404, "not_found");
      return view;
    },
  );

  app.post<{ Params: ProjectParams; Body: { itemIds: string[] } }>(
    "/projects/:projectId/download-links",
    { schema: { body: downloadBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId;
      if (!uuidPattern.test(projectId)) return fail(reply, 404, "not_found");
      if (request.body.itemIds.some((id) => !uuidPattern.test(id))) {
        return fail(reply, 400, "bad_request");
      }
      const items = await downloadLinks(
        projectId as ProjectId,
        request.authenticated!.user.id,
        request.body.itemIds as ProjectItemId[],
      );
      if (!items) return fail(reply, 404, "not_found");
      return { items };
    },
  );

  app.get<{ Params: MediaParams }>(
    "/projects/:projectId/media/:mediaId/download",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!(await accessOr404(request, reply))) return reply;
      const mediaId = request.params.mediaId;
      if (!uuidPattern.test(mediaId)) return fail(reply, 404, "not_found");
      const item = await getItemByMedia(request.params.projectId as ProjectId, mediaId as MediaId);
      if (!item) return fail(reply, 404, "not_found");
      const media = await getMedia(mediaId as MediaId);
      if (!media) return fail(reply, 404, "not_found");
      return { url: await downloadUrl(media.storageKey, config.media.downloadTtlSeconds()) };
    },
  );

  app.patch<{
    Params: MediaParams;
    Body: { capturedAt?: string | null; latitude?: number | null; longitude?: number | null };
  }>(
    "/projects/:projectId/media/:mediaId",
    { schema: { body: mediaBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId as ProjectId;
      const mediaId = request.params.mediaId as MediaId;
      if (!uuidPattern.test(mediaId)) return fail(reply, 404, "not_found");
      const body = request.body;
      const patch: MediaPatch = {
        ...(body.capturedAt === undefined
          ? {}
          : { capturedAt: body.capturedAt === null ? null : new Date(body.capturedAt) }),
        ...(body.latitude === undefined ? {} : { latitude: body.latitude }),
        ...(body.longitude === undefined ? {} : { longitude: body.longitude }),
      };
      const result = await updateMedia(projectId, mediaId, request.authenticated!.user.id, patch);
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      return mediaView(result.media);
    },
  );

  app.delete<{ Params: MediaParams }>(
    "/projects/:projectId/media/:mediaId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId as ProjectId;
      const mediaId = request.params.mediaId as MediaId;
      if (!uuidPattern.test(mediaId)) return fail(reply, 404, "not_found");
      const result = await removeMedia(projectId, mediaId, request.authenticated!.user.id);
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      if (result.keys.length > 0) await deleteObjects(result.keys);
      return { ok: true };
    },
  );

  app.patch<{ Params: ItemParams; Body: { description: string | null } }>(
    "/projects/:projectId/items/:itemId",
    { schema: { body: itemBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId as ProjectId;
      const itemId = request.params.itemId as ProjectItemId;
      if (!uuidPattern.test(itemId)) return fail(reply, 404, "not_found");
      const result = await updateItemDescription(
        projectId,
        itemId,
        request.authenticated!.user.id,
        request.body.description,
      );
      if ("denial" in result) {
        return result.denial === "forbidden"
          ? fail(reply, 403, "forbidden")
          : fail(reply, 404, "not_found");
      }
      return itemView(projectId, itemId, request.authenticated!.user.id);
    },
  );
}
