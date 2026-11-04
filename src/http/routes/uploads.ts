import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { accessOf, canContribute } from "../../domains/project/access.ts";
import {
  cancelUpload,
  completeMediaUpload,
  listUploads,
  resumeUpload,
  startUpload,
} from "../../domains/upload/upload.ts";
import { decodeCursor, limitOf } from "../../pagination.ts";
import type { ProjectId, UploadId, UserId } from "../../types/id.ts";
import { fail } from "../errors.ts";
import { allow } from "../rate-limit.ts";

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

const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    cursor: { type: "string", minLength: 1, maxLength: 200 },
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
  app.get<{
    Params: ProjectParams;
    Querystring: { userId?: string; limit?: number; cursor?: string };
  }>(
    "/projects/:projectId/uploads",
    { schema: { querystring: listQuery }, preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId;
      if (!uuidPattern.test(projectId)) return fail(reply, 404, "not_found");
      const access = await accessOf(projectId as ProjectId, request.authenticated!.user.id);
      if (!access) return fail(reply, 404, "not_found");
      const userId = request.query.userId;
      if (userId !== undefined && !uuidPattern.test(userId)) {
        return fail(reply, 400, "bad_request");
      }
      const cursor = request.query.cursor;
      const after = cursor ? (decodeCursor(cursor) ?? null) : null;
      if (cursor && !after) return fail(reply, 400, "bad_request");
      return listUploads(
        projectId as ProjectId,
        userId as UserId | undefined,
        limitOf(request.query.limit),
        after,
      );
    },
  );

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
      if (!uuidPattern.test(projectId)) return fail(reply, 404, "not_found");
      const access = await accessOf(projectId as ProjectId, request.authenticated!.user.id);
      if (!access) return fail(reply, 404, "not_found");
      if (!canContribute(access)) return fail(reply, 403, "forbidden");
      if (
        !allow(
          "uploads",
          request.authenticated!.user.id,
          config.rate.uploads(),
          config.rate.windowMs(),
        )
      ) {
        return fail(reply, 429, "limit_exceeded");
      }
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
        if (result.denial === "too_large") return fail(reply, 413, "limit_exceeded");
        if (result.denial === "unsupported_format") {
          return fail(reply, 400, "bad_request");
        }
        if (result.denial === "storage_unavailable") {
          return fail(reply, 503, "storage_unavailable");
        }
        return fail(reply, 409, "limit_exceeded");
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
      if (!access) return fail(reply, 404, "not_found");
      if (!canContribute(access)) return fail(reply, 403, "forbidden");
      const uploadId = request.params.uploadId;
      if (!uuidPattern.test(uploadId)) return fail(reply, 404, "not_found");
      const plan = await resumeUpload(
        uploadId as UploadId,
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!plan) return fail(reply, 404, "not_found");
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
      if (!access) return fail(reply, 404, "not_found");
      if (!canContribute(access)) return fail(reply, 403, "forbidden");
      const uploadId = request.params.uploadId;
      if (!uuidPattern.test(uploadId)) return fail(reply, 404, "not_found");
      const result = await completeMediaUpload({
        id: uploadId as UploadId,
        projectId: request.params.projectId as ProjectId,
        userId: request.authenticated!.user.id,
        parts: request.body.parts,
      });
      if ("denial" in result) {
        if (result.denial === "too_large") return fail(reply, 413, "limit_exceeded");
        if (result.denial === "storage_error") {
          return fail(reply, 502, "storage_unavailable");
        }
        return fail(reply, 404, "not_found");
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
      if (!access) return fail(reply, 404, "not_found");
      if (!canContribute(access)) return fail(reply, 403, "forbidden");
      const uploadId = request.params.uploadId;
      if (!uuidPattern.test(uploadId)) return fail(reply, 404, "not_found");
      const cancelled = await cancelUpload(
        uploadId as UploadId,
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (!cancelled) return fail(reply, 404, "not_found");
      return { ok: true };
    },
  );
}
