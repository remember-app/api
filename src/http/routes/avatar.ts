import type { FastifyInstance } from "fastify";
import { avatarUrl, removeAvatar, setAvatar } from "../../services/avatar/commands.ts";
import type { MediaId } from "../../types/id.ts";
import { fail } from "../errors.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const setBody = {
  type: "object",
  required: ["mediaId"],
  additionalProperties: false,
  properties: { mediaId: { type: "string" } },
} as const;

export function avatarRoutes(app: FastifyInstance) {
  app.post<{ Body: { mediaId: string } }>(
    "/me/avatar",
    { schema: { body: setBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.body.mediaId)) return fail(reply, 404, "not_found");
      const result = await setAvatar(
        request.authenticated!.user.id,
        request.body.mediaId as MediaId,
      );
      if ("denial" in result) {
        return result.denial === "bad_request"
          ? fail(reply, 400, "bad_request")
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
