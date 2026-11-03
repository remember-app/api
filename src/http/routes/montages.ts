import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import {
  createMontage,
  getMontage,
  listJournal,
  listMontages,
  listTemplates,
} from "../../domains/montage/montage.ts";
import { accessOf, isAdmin } from "../../domains/project/access.ts";
import { montageFailedMessage, movieReadyMessage } from "../../domains/push/messages.ts";
import { removeTokens, tokensOfProject } from "../../domains/push/push.ts";
import { sendPush } from "../../integrations/push/index.ts";
import type { MontageId, ProjectId, TemplateId, UserId } from "../../types/id.ts";
import type { MontageConfig } from "../../types/montage.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

type ProjectParams = { projectId: string };
type MontageParams = { projectId: string; montageId: string };

const configBody = {
  type: "object",
  required: ["targetSeconds", "dimensions"],
  additionalProperties: false,
  properties: {
    targetSeconds: { type: "integer", minimum: 1 },
    prompt: { type: ["string", "null"], maxLength: 4000 },
    includeMediaIds: { type: "array", uniqueItems: true, items: { type: "string" } },
    requiredMediaIds: { type: "array", uniqueItems: true, items: { type: "string" } },
    musicIds: {
      type: ["array", "null"],
      uniqueItems: true,
      items: { type: "string" },
    },
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
  required: ["config"],
  additionalProperties: false,
  properties: {
    templateId: { type: ["string", "null"] },
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
      if (!access) return reply.code(404).send({ error: "not_found" });
      return listTemplates();
    },
  );

  app.post<{
    Params: ProjectParams;
    Body: { templateId?: string | null; config: MontageConfig };
  }>(
    "/projects/:projectId/montages",
    { schema: { body: createBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!isAdmin(access)) return reply.code(403).send({ error: "forbidden" });
      const result = await createMontage({
        projectId: request.params.projectId as ProjectId,
        createdBy: request.authenticated!.user.id,
        templateId: (request.body.templateId as TemplateId | null | undefined) ?? null,
        config: {
          ...request.body.config,
          prompt: request.body.config.prompt ?? null,
          includeMediaIds: request.body.config.includeMediaIds ?? [],
          requiredMediaIds: request.body.config.requiredMediaIds ?? [],
          musicIds: request.body.config.musicIds ?? null,
        },
      });
      if ("denial" in result) {
        return reply.code(400).send({ error: "bad_request", details: result.problems });
      }
      return result.montage;
    },
  );

  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/montages",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return reply.code(404).send({ error: "not_found" });
      return listMontages(request.params.projectId as ProjectId);
    },
  );

  app.get<{ Params: MontageParams }>(
    "/projects/:projectId/montages/:montageId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!uuidPattern.test(request.params.montageId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const montage = await getMontage(request.params.montageId as MontageId);
      if (!montage || montage.projectId !== request.params.projectId) {
        return reply.code(404).send({ error: "not_found" });
      }
      return montage;
    },
  );

  app.get<{ Params: MontageParams }>(
    "/projects/:projectId/montages/:montageId/journal",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await memberAccess(request.params.projectId, request.authenticated!.user.id);
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!uuidPattern.test(request.params.montageId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      return listJournal(request.params.montageId as MontageId);
    },
  );

  app.post<{ Params: { montageId: string } }>(
    "/internal/montages/:montageId/ready",
    async (request, reply) => {
      if (!secretMatches(request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const montageId = request.params.montageId;
      if (!uuidPattern.test(montageId)) return reply.code(404).send({ error: "not_found" });
      const montage = await getMontage(montageId as MontageId);
      if (!montage) return reply.code(404).send({ error: "not_found" });
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
        return reply.code(401).send({ error: "unauthorized" });
      }
      const montageId = request.params.montageId;
      if (!uuidPattern.test(montageId)) return reply.code(404).send({ error: "not_found" });
      const montage = await getMontage(montageId as MontageId);
      if (!montage) return reply.code(404).send({ error: "not_found" });
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
