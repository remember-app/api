import type { FastifyInstance } from "fastify";
import {
  attachLabels,
  createLabel,
  deleteLabel,
  detachLabels,
  getLabel,
  listLabels,
  updateLabel,
} from "../../domains/label/label.ts";
import type { ProjectAccess } from "../../domains/project/access.ts";
import { accessOf, canContribute } from "../../domains/project/access.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import type { LabelId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { Label } from "../../types/label.ts";
import { fail } from "../errors.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

type ProjectParams = { projectId: string };
type LabelParams = { projectId: string; labelId: string };

const createBody = {
  type: "object",
  required: ["name", "colorHex", "shared"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    colorHex: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    description: { type: ["string", "null"], maxLength: 1000 },
    shared: { type: "boolean" },
  },
} as const;

const patchBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    colorHex: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    description: { type: ["string", "null"], maxLength: 1000 },
  },
} as const;

const itemsBody = {
  type: "object",
  required: ["itemIds"],
  additionalProperties: false,
  properties: {
    itemIds: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string" },
    },
  },
} as const;

const canEditLabel = (label: Label, access: ProjectAccess, userId: UserId): boolean =>
  label.shared ? canContribute(access) : label.ownerId === userId;

async function projectAccess(projectId: string, userId: UserId) {
  if (!uuidPattern.test(projectId)) return undefined;
  return accessOf(projectId as ProjectId, userId);
}

export function labelRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams; Querystring: { limit?: number; offset?: number } }>(
    "/projects/:projectId/labels",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const userId = request.authenticated!.user.id;
      const access = await projectAccess(request.params.projectId, userId);
      if (!access) return fail(reply, 404, "not_found");
      const { limit, offset } = pageOf(request.query);
      return listLabels(request.params.projectId as ProjectId, userId, limit, offset);
    },
  );

  app.post<{
    Params: ProjectParams;
    Body: {
      name: string;
      colorHex: `#${string}`;
      shared: boolean;
      description?: string | null;
    };
  }>(
    "/projects/:projectId/labels",
    { schema: { body: createBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const userId = request.authenticated!.user.id;
      const access = await projectAccess(request.params.projectId, userId);
      if (!access) return fail(reply, 404, "not_found");
      if (request.body.shared && !canContribute(access)) {
        return fail(reply, 403, "forbidden");
      }
      return createLabel({
        projectId: request.params.projectId as ProjectId,
        ownerId: userId,
        name: request.body.name,
        colorHex: request.body.colorHex,
        description: request.body.description ?? null,
        shared: request.body.shared,
      });
    },
  );

  app.patch<{
    Params: LabelParams;
    Body: { name?: string; colorHex?: `#${string}`; description?: string | null };
  }>(
    "/projects/:projectId/labels/:labelId",
    { schema: { body: patchBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const userId = request.authenticated!.user.id;
      const access = await projectAccess(request.params.projectId, userId);
      if (!access) return fail(reply, 404, "not_found");
      const label = await getLabel(request.params.labelId as LabelId);
      if (!label || label.projectId !== request.params.projectId) {
        return fail(reply, 404, "not_found");
      }
      if (!canEditLabel(label, access, userId)) return fail(reply, 403, "forbidden");
      return updateLabel(label.id, label.projectId, request.body);
    },
  );

  app.delete<{ Params: LabelParams }>(
    "/projects/:projectId/labels/:labelId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const userId = request.authenticated!.user.id;
      const access = await projectAccess(request.params.projectId, userId);
      if (!access) return fail(reply, 404, "not_found");
      const label = await getLabel(request.params.labelId as LabelId);
      if (!label || label.projectId !== request.params.projectId) {
        return fail(reply, 404, "not_found");
      }
      if (!canEditLabel(label, access, userId)) return fail(reply, 403, "forbidden");
      await deleteLabel(label.id, label.projectId);
      return { ok: true };
    },
  );

  app.post<{ Params: LabelParams; Body: { itemIds: string[] } }>(
    "/projects/:projectId/labels/:labelId/items",
    { schema: { body: itemsBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const userId = request.authenticated!.user.id;
      const access = await projectAccess(request.params.projectId, userId);
      if (!access) return fail(reply, 404, "not_found");
      const label = await getLabel(request.params.labelId as LabelId);
      if (!label || label.projectId !== request.params.projectId) {
        return fail(reply, 404, "not_found");
      }
      if (!canEditLabel(label, access, userId)) return fail(reply, 403, "forbidden");
      if (request.body.itemIds.some((itemId) => !uuidPattern.test(itemId))) {
        return fail(reply, 400, "bad_request");
      }
      const attached = await attachLabels(
        label.projectId,
        label.id,
        request.body.itemIds as ProjectItemId[],
      );
      return { attached };
    },
  );

  app.delete<{ Params: LabelParams; Body: { itemIds: string[] } }>(
    "/projects/:projectId/labels/:labelId/items",
    { schema: { body: itemsBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const userId = request.authenticated!.user.id;
      const access = await projectAccess(request.params.projectId, userId);
      if (!access) return fail(reply, 404, "not_found");
      const label = await getLabel(request.params.labelId as LabelId);
      if (!label || label.projectId !== request.params.projectId) {
        return fail(reply, 404, "not_found");
      }
      if (!canEditLabel(label, access, userId)) return fail(reply, 403, "forbidden");
      if (request.body.itemIds.some((itemId) => !uuidPattern.test(itemId))) {
        return fail(reply, 400, "bad_request");
      }
      const detached = await detachLabels(
        label.projectId,
        label.id,
        request.body.itemIds as ProjectItemId[],
      );
      return { detached };
    },
  );
}
