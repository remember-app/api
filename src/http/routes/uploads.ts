import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { decodeCursor, limitOf } from "../../pagination.ts";
import {
  cancelUpload,
  completeMediaUpload,
  resumeUpload,
  startUpload,
} from "../../services/upload/commands.ts";
import { listUploads } from "../../services/upload/queries.ts";
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
    fingerprint: { type: ["string", "null"], pattern: "^[a-fA-F0-9]{64}$" },
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
      const userId = request.query.userId;
      if (userId !== undefined && !uuidPattern.test(userId)) {
        return fail(reply, 400, "bad_request");
      }
      const cursor = request.query.cursor;
      const after = cursor ? (decodeCursor(cursor) ?? null) : null;
      if (cursor && !after) return fail(reply, 400, "bad_request");
      const page = await listUploads(
        projectId as ProjectId,
        request.authenticated!.user.id,
        userId as UserId | undefined,
        limitOf(request.query.limit),
        after,
      );
      if (!page) return fail(reply, 404, "not_found");
      return page;
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
      fingerprint?: string | null;
    };
  }>(
    "/projects/:projectId/uploads",
    { schema: { body: startBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId;
      if (!uuidPattern.test(projectId)) return fail(reply, 404, "not_found");
      if (
        !allow(
          "uploads",
          request.authenticated!.user.id,
          config.rate.uploads(),
          config.rate.windowMs(),
        )
      ) {
        return fail(reply, 429, "capacity_exceeded");
      }
      const result = await startUpload({
        projectId: projectId as ProjectId,
        userId: request.authenticated!.user.id,
        kind: request.body.kind,
        sizeBytes: request.body.sizeBytes,
        fileName: request.body.fileName,
        capturedAt: request.body.capturedAt ? new Date(request.body.capturedAt) : null,
        durationSeconds: request.body.durationSeconds ?? null,
        fingerprint: request.body.fingerprint?.toLowerCase() ?? null,
      });
      if ("denial" in result) {
        if (result.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (result.denial === "not_found") return fail(reply, 404, "not_found");
        if (result.denial === "too_large") return fail(reply, 413, "capacity_exceeded");
        if (result.denial === "too_long") return fail(reply, 400, "too_long");
        if (result.denial === "insufficient_storage") {
          return fail(reply, 409, "capacity_exceeded");
        }
        if (result.denial === "unsupported_format") {
          return fail(reply, 400, "bad_request");
        }
        if (result.denial === "storage_unavailable") {
          return fail(reply, 503, "storage_unavailable");
        }
        return fail(reply, 409, "capacity_exceeded");
      }
      return result.plan;
    },
  );

  app.get<{ Params: UploadParams }>(
    "/projects/:projectId/uploads/:uploadId",
    { preHandler: app.authenticate },
    async (request, reply) => {
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
      const uploadId = request.params.uploadId;
      if (!uuidPattern.test(uploadId)) return fail(reply, 404, "not_found");
      const result = await completeMediaUpload({
        id: uploadId as UploadId,
        projectId: request.params.projectId as ProjectId,
        userId: request.authenticated!.user.id,
        parts: request.body.parts,
      });
      if ("denial" in result) {
        if (result.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (result.denial === "too_large") return fail(reply, 413, "capacity_exceeded");
        if (result.denial === "insufficient_storage") {
          return fail(reply, 409, "capacity_exceeded");
        }
        if (result.denial === "storage_error") {
          return fail(reply, 502, "storage_unavailable");
        }
        return fail(reply, 404, "not_found");
      }
      return { mediaId: result.media.id, itemId: result.itemId, status: "processing" };
    },
  );

  app.delete<{ Params: UploadParams }>(
    "/projects/:projectId/uploads/:uploadId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const uploadId = request.params.uploadId;
      if (!uuidPattern.test(uploadId)) return fail(reply, 404, "not_found");
      const result = await cancelUpload(
        uploadId as UploadId,
        request.params.projectId as ProjectId,
        request.authenticated!.user.id,
      );
      if (result === "forbidden") return fail(reply, 403, "forbidden");
      if (result === "not_found") return fail(reply, 404, "not_found");
      return { ok: true };
    },
  );
}
