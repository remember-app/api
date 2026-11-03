import type { FastifyInstance } from "fastify";
import { accessOf, canContribute } from "../../domains/project/access.ts";
import {
  cancelUpload,
  completeMediaUpload,
  resumeUpload,
  startUpload,
} from "../../domains/upload/upload.ts";
import type { MediaId, ProjectId } from "../../types/id.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

type ProjectParams = { projectId: string };
type UploadParams = { projectId: string; uploadId: string };

const startBody = {
  type: "object",
  required: ["kind", "sizeBytes", "fileName"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["photo", "video", "audio"] },
    sizeBytes: { type: "integer", minimum: 1 },
    fileName: { type: "string", minLength: 1, maxLength: 255 },
    capturedAt: { type: ["string", "null"], format: "date-time" },
    durationSeconds: { type: ["number", "null"], minimum: 0 },
  },
} as const;

const completeBody = {
  type: "object",
  required: ["parts"],
  additionalProperties: false,
  properties: {
    parts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["part_number", "etag"],
        additionalProperties: false,
        properties: {
          part_number: { type: "integer", minimum: 1 },
          etag: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

export function uploadRoutes(app: FastifyInstance) {
  app.post<{
    Params: ProjectParams;
    Body: {
      kind: "photo" | "video" | "audio";
      sizeBytes: number;
      fileName: string;
      capturedAt?: string | null;
      durationSeconds?: number | null;
    };
  }>(
    "/projects/:projectId/uploads",
    { schema: { body: startBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId;
      if (!uuidPattern.test(projectId)) return reply.code(404).send({ error: "not_found" });
      const access = await accessOf(projectId as ProjectId, request.authenticated!.user.id);
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!canContribute(access)) return reply.code(403).send({ error: "forbidden" });
      const result = await startUpload({
        projectId: projectId as ProjectId,
        userId: request.authenticated!.user.id,
        kind: request.body.kind,
        sizeBytes: request.body.sizeBytes,
        fileName: request.body.fileName,
        capturedAt: request.body.capturedAt ? new Date(request.body.capturedAt) : null,
        durationSeconds: request.body.durationSeconds ?? null,
      });
      if ("denial" in result) {
        if (result.denial === "too_large") return reply.code(413).send({ error: "limit_exceeded" });
        if (result.denial === "unsupported_format") {
          return reply.code(400).send({ error: "bad_request" });
        }
        if (result.denial === "storage_unavailable") {
          return reply.code(503).send({ error: "storage_unavailable" });
        }
        return reply.code(409).send({ error: "limit_exceeded" });
      }
      return result.plan;
    },
  );

  app.get<{ Params: UploadParams }>(
    "/projects/:projectId/uploads/:uploadId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!canContribute(access)) return reply.code(403).send({ error: "forbidden" });
      const uploadId = request.params.uploadId;
      if (!uuidPattern.test(uploadId)) return reply.code(404).send({ error: "not_found" });
      const plan = await resumeUpload(
        uploadId as MediaId,
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!plan) return reply.code(404).send({ error: "not_found" });
      return plan;
    },
  );

  app.post<{
    Params: UploadParams;
    Body: { parts: { part_number: number; etag: string }[] };
  }>(
    "/projects/:projectId/uploads/:uploadId/complete",
    { schema: { body: completeBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!canContribute(access)) return reply.code(403).send({ error: "forbidden" });
      const uploadId = request.params.uploadId;
      if (!uuidPattern.test(uploadId)) return reply.code(404).send({ error: "not_found" });
      const result = await completeMediaUpload({
        id: uploadId as MediaId,
        projectId: request.params.projectId as ProjectId,
        userId: request.authenticated!.user.id,
        parts: request.body.parts,
      });
      if ("denial" in result) {
        if (result.denial === "too_large") return reply.code(413).send({ error: "limit_exceeded" });
        if (result.denial === "storage_error") {
          return reply.code(502).send({ error: "storage_unavailable" });
        }
        if (result.denial === "unsupported_format") {
          return reply.code(400).send({ error: "bad_request" });
        }
        return reply.code(404).send({ error: "not_found" });
      }
      return { id: result.media.id, itemId: result.itemId, status: "processing" };
    },
  );

  app.delete<{ Params: UploadParams }>(
    "/projects/:projectId/uploads/:uploadId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const access = await accessOf(
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!access) return reply.code(404).send({ error: "not_found" });
      if (!canContribute(access)) return reply.code(403).send({ error: "forbidden" });
      const uploadId = request.params.uploadId;
      if (!uuidPattern.test(uploadId)) return reply.code(404).send({ error: "not_found" });
      const cancelled = await cancelUpload(
        uploadId as MediaId,
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!cancelled) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );
}
