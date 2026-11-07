import type { FastifyInstance } from "fastify";
import { storageConfigured } from "../../integrations/storage/s3.ts";
import {
  avatarUrl,
  completeAvatarUpload,
  removeAvatar,
  startAvatarUpload,
} from "../../services/avatar/commands.ts";
import type { MediaId } from "../../types/id.ts";
import { fail } from "../errors.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const startBody = {
  type: "object",
  required: ["fileName"],
  additionalProperties: false,
  properties: { fileName: { type: "string", minLength: 1, maxLength: 255 } },
} as const;

export function avatarRoutes(app: FastifyInstance) {
  app.post<{ Body: { fileName: string } }>(
    "/me/avatar",
    { schema: { body: startBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!storageConfigured()) return fail(reply, 503, "storage_unavailable");
      const result = await startAvatarUpload(request.authenticated!.user.id, request.body.fileName);
      if ("denial" in result) return fail(reply, 400, "bad_request");
      return result;
    },
  );

  app.post<{ Params: { mediaId: string } }>(
    "/me/avatar/:mediaId/complete",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!storageConfigured()) return fail(reply, 503, "storage_unavailable");
      if (!uuidPattern.test(request.params.mediaId)) return fail(reply, 404, "not_found");
      const result = await completeAvatarUpload(
        request.authenticated!.user.id,
        request.params.mediaId as MediaId,
      );
      if ("denial" in result) {
        return result.denial === "too_large"
          ? fail(reply, 413, "capacity_exceeded")
          : fail(reply, 404, "not_found");
      }
      return result;
    },
  );

  app.get("/me/avatar", { preHandler: app.authenticate }, async (request) => {
    return { url: await avatarUrl(request.authenticated!.user.id) };
  });

  app.delete("/me/avatar", { preHandler: app.authenticate }, async (request) => {
    await removeAvatar(request.authenticated!.user.id);
    return { ok: true };
  });
}
