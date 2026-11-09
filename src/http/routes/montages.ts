import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { sendPush } from "../../integrations/push/index.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import {
  createMontage,
  getMontage,
  listJournal,
  listMontages,
  listTemplates,
  type MontagePaySource,
} from "../../services/montage/montage.ts";
import { accessOf, isAdmin } from "../../services/project/access.ts";
import { removeTokens } from "../../services/push/commands.ts";
import { montageFailedMessage, movieReadyMessage } from "../../services/push/messages.ts";
import { tokensOfProject } from "../../services/push/queries.ts";
import type { MontageId, ProjectId, TemplateId, UserId } from "../../types/id.ts";
import type { MontageSetting, MontageSource } from "../../types/montage.ts";
import { fail } from "../errors.ts";
import { allow } from "../rate-limit.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

type ProjectParams = { projectId: string };
type MontageParams = { projectId: string; montageId: string };

const configBody = {
  type: "object",
  required: ["targetSeconds", "dimensions", "includeItemIds", "musicIds"],
  additionalProperties: false,
  properties: {
    targetSeconds: { type: "integer", minimum: 1 },
    prompt: { type: ["string", "null"], maxLength: 4000 },
    includeItemIds: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string" },
    },
    requiredItemIds: { type: "array", uniqueItems: true, items: { type: "string" } },
    musicIds: { type: "array", uniqueItems: true, items: { type: "string" } },
    dimensions: {
      type: "object",
      required: ["width", "height"],
      additionalProperties: false,
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
    },
  },
} as const;

const createBody = {
  type: "object",
  required: ["config", "payFrom"],
  additionalProperties: false,
  properties: {
    templateId: { type: ["string", "null"] },
    payFrom: { type: "string", enum: ["project", "user"] },
    config: configBody,
  },
} as const;

const secretMatches = (header: string | undefined) => {
  const secret = config.worker.token();
  if (!secret) return false;
  const given = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
};

async function memberAccess(projectId: string, userId: UserId) {
  if (!uuidPattern.test(projectId)) return undefined;
  return accessOf(projectId as ProjectId, userId);
}

export function montageRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/montage-templates",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return fail(reply, 404, "not_found");
      return listTemplates();
    },
  );

  app.post<{
    Params: ProjectParams;
    Body: {
      templateId?: string | null;
      payFrom: MontagePaySource;
      config: MontageSetting & MontageSource;
    };
  }>(
    "/projects/:projectId/montages",
    { schema: { body: createBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return fail(reply, 404, "not_found");
      if (!isAdmin(access)) return fail(reply, 403, "forbidden");
      if (
        !allow(
          "montages",
          request.authenticated!.user.id,
          config.rate.montages(),
          config.rate.windowMs(),
        )
      ) {
        return fail(reply, 429, "capacity_exceeded");
      }
      const result = await createMontage({
        projectId: request.params.projectId as ProjectId,
        createdBy: request.authenticated!.user.id,
        templateId: (request.body.templateId as TemplateId | null | undefined) ?? null,
        payFrom: request.body.payFrom,
        config: {
          targetSeconds: request.body.config.targetSeconds,
          prompt: request.body.config.prompt ?? null,
          dimensions: request.body.config.dimensions,
          includeItemIds: request.body.config.includeItemIds,
          requiredItemIds: request.body.config.requiredItemIds ?? [],
          musicIds: request.body.config.musicIds,
        },
      });
      if ("denial" in result) {
        if (result.denial === "insufficient_tokens") {
          return fail(reply, 409, "capacity_exceeded");
        }
        return fail(reply, 400, "bad_request", result.problems);
      }
      return result.montage;
    },
  );

  app.get<{ Params: ProjectParams; Querystring: { limit?: number; offset?: number } }>(
    "/projects/:projectId/montages",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return fail(reply, 404, "not_found");
      const { limit, offset } = pageOf(request.query);
      return listMontages(request.params.projectId as ProjectId, limit, offset);
    },
  );

  app.get<{ Params: MontageParams }>(
    "/projects/:projectId/montages/:montageId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return fail(reply, 404, "not_found");
      if (!uuidPattern.test(request.params.montageId)) {
        return fail(reply, 404, "not_found");
      }
      const montage = await getMontage(request.params.montageId as MontageId);
      if (!montage || montage.projectId !== request.params.projectId) {
        return fail(reply, 404, "not_found");
      }
      return montage;
    },
  );

  app.get<{
    Params: MontageParams;
    Querystring: { limit?: number; offset?: number };
  }>(
    "/projects/:projectId/montages/:montageId/journal",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return fail(reply, 404, "not_found");
      if (!uuidPattern.test(request.params.montageId)) {
        return fail(reply, 404, "not_found");
      }
      const { limit, offset } = pageOf(request.query);
      return listJournal(request.params.montageId as MontageId, limit, offset);
    },
  );

  app.post<{ Params: { montageId: string } }>(
    "/internal/montages/:montageId/ready",
    async (request, reply) => {
      if (!secretMatches(request.headers.authorization)) {
        return fail(reply, 401, "unauthorized");
      }
      const montageId = request.params.montageId;
      if (!uuidPattern.test(montageId)) return fail(reply, 404, "not_found");
      const montage = await getMontage(montageId as MontageId);
      if (!montage) return fail(reply, 404, "not_found");
      const tokens = await tokensOfProject(montage.projectId);
      if (tokens.length > 0) {
        const result = await sendPush(
          tokens.map((token) => ({ token: token.token, ...movieReadyMessage(montageId) })),
        );
        if (!result.ok) {
          request.log.warn(
            { status: result.status, error: result.error },
            "movie-ready push not sent",
          );
        }
        if (result.deadTokens.length > 0) await removeTokens(result.deadTokens);
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { montageId: string }; Body: { error?: string | null } }>(
    "/internal/montages/:montageId/failed",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { error: { type: ["string", "null"], maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      if (!secretMatches(request.headers.authorization)) {
        return fail(reply, 401, "unauthorized");
      }
      const montageId = request.params.montageId;
      if (!uuidPattern.test(montageId)) return fail(reply, 404, "not_found");
      const montage = await getMontage(montageId as MontageId);
      if (!montage) return fail(reply, 404, "not_found");
      const tokens = await tokensOfProject(montage.projectId);
      if (tokens.length > 0) {
        const result = await sendPush(
          tokens.map((token) => ({ token: token.token, ...montageFailedMessage(montageId) })),
        );
        if (!result.ok) {
          request.log.warn(
            { status: result.status, error: result.error },
            "montage-failed push not sent",
          );
        }
        if (result.deadTokens.length > 0) await removeTokens(result.deadTokens);
      }
      return { ok: true };
    },
  );
}
