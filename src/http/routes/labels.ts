import type { FastifyInstance, FastifyReply } from "fastify";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import {
  attachLabels,
  createLabel,
  deleteLabel,
  detachLabels,
  updateLabel,
} from "../../services/label/commands.ts";
import { listLabels } from "../../services/label/queries.ts";
import type { LabelId, ProjectId, ProjectItemId } from "../../types/id.ts";
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

const denial = (reply: FastifyReply, reason: "not_found" | "forbidden") =>
  reason === "forbidden" ? fail(reply, 403, "forbidden") : fail(reply, 404, "not_found");

export function labelRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams; Querystring: { limit?: number; offset?: number } }>(
    "/projects/:projectId/labels",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.projectId)) return fail(reply, 404, "not_found");
      const { limit, offset } = pageOf(request.query);
      const page = await listLabels(
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
      if (!uuidPattern.test(request.params.projectId)) return fail(reply, 404, "not_found");
      const result = await createLabel(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
        {
          name: request.body.name,
          colorHex: request.body.colorHex,
          description: request.body.description ?? null,
          shared: request.body.shared,
        },
      );
      if ("denial" in result) return denial(reply, result.denial);
      return result.label;
    },
  );

  app.patch<{
    Params: LabelParams;
    Body: { name?: string; colorHex?: `#${string}`; description?: string | null };
  }>(
    "/projects/:projectId/labels/:labelId",
    { schema: { body: patchBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (
        !uuidPattern.test(request.params.projectId) ||
        !uuidPattern.test(request.params.labelId)
      ) {
        return fail(reply, 404, "not_found");
      }
      const result = await updateLabel(
        request.params.projectId as ProjectId,
        request.params.labelId as LabelId,
        request.authenticated!.user.id,
        request.body,
      );
      if ("denial" in result) return denial(reply, result.denial);
      return result.label;
    },
  );

  app.delete<{ Params: LabelParams }>(
    "/projects/:projectId/labels/:labelId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (
        !uuidPattern.test(request.params.projectId) ||
        !uuidPattern.test(request.params.labelId)
      ) {
        return fail(reply, 404, "not_found");
      }
      const result = await deleteLabel(
        request.params.projectId as ProjectId,
        request.params.labelId as LabelId,
        request.authenticated!.user.id,
      );
      if ("denial" in result) return denial(reply, result.denial);
      return { ok: true };
    },
  );

  app.post<{ Params: LabelParams; Body: { itemIds: string[] } }>(
    "/projects/:projectId/labels/:labelId/items",
    { schema: { body: itemsBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (
        !uuidPattern.test(request.params.projectId) ||
        !uuidPattern.test(request.params.labelId)
      ) {
        return fail(reply, 404, "not_found");
      }
      if (request.body.itemIds.some((itemId) => !uuidPattern.test(itemId))) {
        return fail(reply, 400, "bad_request");
      }
      const result = await attachLabels(
        request.params.projectId as ProjectId,
        request.params.labelId as LabelId,
        request.authenticated!.user.id,
        request.body.itemIds as ProjectItemId[],
      );
      if ("denial" in result) return denial(reply, result.denial);
      return result;
    },
  );

  app.delete<{ Params: LabelParams; Body: { itemIds: string[] } }>(
    "/projects/:projectId/labels/:labelId/items",
    { schema: { body: itemsBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (
        !uuidPattern.test(request.params.projectId) ||
        !uuidPattern.test(request.params.labelId)
      ) {
        return fail(reply, 404, "not_found");
      }
      if (request.body.itemIds.some((itemId) => !uuidPattern.test(itemId))) {
        return fail(reply, 400, "bad_request");
      }
      const result = await detachLabels(
        request.params.projectId as ProjectId,
        request.params.labelId as LabelId,
        request.authenticated!.user.id,
        request.body.itemIds as ProjectItemId[],
      );
      if ("denial" in result) return denial(reply, result.denial);
      return result;
    },
  );
}
