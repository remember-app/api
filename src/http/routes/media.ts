import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.ts";
import { deleteMedia, getMedia, setCapturedAt, setMediaPlace } from "../../domains/media/media.ts";
import { accessOf, canContribute, isAdmin } from "../../domains/project/access.ts";
import {
  getItem,
  getItemByMedia,
  listItems,
  removeItem,
  setItemDescription,
} from "../../domains/project/item.ts";
import { deleteObjects, downloadUrl } from "../../integrations/storage/s3.ts";
import type { MediaId, ProjectId, ProjectItemId } from "../../types/id.ts";

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

async function accessOr404(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  const projectId = request.params.projectId;
  if (!uuidPattern.test(projectId)) {
    await reply.code(404).send({ error: "not_found" });
    return undefined;
  }
  const access = await accessOf(projectId as ProjectId, request.authenticated!.user.id);
  if (!access) {
    await reply.code(404).send({ error: "not_found" });
    return undefined;
  }
  return access;
}

const sign = (key: string | undefined | null, ttl: number) =>
  key ? downloadUrl(key, ttl) : Promise.resolve(null);

export function mediaRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/media",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!(await accessOr404(request, reply))) return reply;
      const ttl = config.media.downloadTtlSeconds();
      const items = await listItems(request.params.projectId as ProjectId);
      return Promise.all(
        items.map(async (item) => {
          const media = await getMedia(item.mediaId);
          const thumbnail = item.derivedMedia.thumbnailId
            ? await getMedia(item.derivedMedia.thumbnailId)
            : undefined;
          const preview =
            "previewId" in item.derivedMedia && item.derivedMedia.previewId
              ? await getMedia(item.derivedMedia.previewId)
              : undefined;
          return {
            item,
            media,
            original_url: await sign(media?.storageKey, ttl),
            thumbnail_url: await sign(thumbnail?.storageKey, ttl),
            preview_url: await sign(preview?.storageKey, ttl),
          };
        }),
      );
    },
  );

  app.get<{ Params: MediaParams }>(
    "/projects/:projectId/media/:mediaId/download",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!(await accessOr404(request, reply))) return reply;
      const mediaId = request.params.mediaId;
      if (!uuidPattern.test(mediaId)) return reply.code(404).send({ error: "not_found" });
      const item = await getItemByMedia(request.params.projectId as ProjectId, mediaId as MediaId);
      if (!item) return reply.code(404).send({ error: "not_found" });
      const media = await getMedia(mediaId as MediaId);
      if (!media) return reply.code(404).send({ error: "not_found" });
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
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      const projectId = request.params.projectId as ProjectId;
      const mediaId = request.params.mediaId as MediaId;
      if (!uuidPattern.test(mediaId)) return reply.code(404).send({ error: "not_found" });
      const media = await getMedia(mediaId);
      if (!media) return reply.code(404).send({ error: "not_found" });
      if (!isAdmin(access) && media.uploadedBy !== request.authenticated!.user.id) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (!(await getItemByMedia(projectId, mediaId))) {
        return reply.code(404).send({ error: "not_found" });
      }
      const body = request.body;
      if (body.capturedAt !== undefined) {
        await setCapturedAt(mediaId, body.capturedAt === null ? null : new Date(body.capturedAt));
      }
      if (body.latitude !== undefined && body.longitude !== undefined) {
        await setMediaPlace(
          mediaId,
          body.latitude === null || body.longitude === null
            ? null
            : { latitude: body.latitude, longitude: body.longitude, editedAt: new Date() },
        );
      }
      return getMedia(mediaId);
    },
  );

  app.delete<{ Params: MediaParams }>(
    "/projects/:projectId/media/:mediaId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      const projectId = request.params.projectId as ProjectId;
      const mediaId = request.params.mediaId as MediaId;
      if (!uuidPattern.test(mediaId)) return reply.code(404).send({ error: "not_found" });
      const item = await getItemByMedia(projectId, mediaId);
      if (!item) return reply.code(404).send({ error: "not_found" });
      const media = await getMedia(mediaId);
      if (media && !isAdmin(access) && media.uploadedBy !== request.authenticated!.user.id) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const derived = [
        item.derivedMedia.thumbnailId,
        "previewId" in item.derivedMedia ? item.derivedMedia.previewId : null,
      ].filter((id): id is MediaId => id !== null);
      await removeItem(projectId, item.id);
      const keys: string[] = [];
      const originalKey = await deleteMedia(mediaId);
      if (originalKey) keys.push(originalKey);
      for (const id of derived) {
        const key = await deleteMedia(id);
        if (key) keys.push(key);
      }
      if (keys.length > 0) await deleteObjects(keys);
      return { ok: true };
    },
  );

  app.patch<{ Params: ItemParams; Body: { description: string | null } }>(
    "/projects/:projectId/items/:itemId",
    { schema: { body: itemBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOr404(request, reply);
      if (!access) return reply;
      if (!canContribute(access)) return reply.code(403).send({ error: "forbidden" });
      const updated = await setItemDescription(
        request.params.projectId as ProjectId,
        request.params.itemId as ProjectItemId,
        request.body.description,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return getItem(request.params.projectId as ProjectId, request.params.itemId as ProjectItemId);
    },
  );
}
