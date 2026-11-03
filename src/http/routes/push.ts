import type { FastifyInstance } from "fastify";
import { registerToken, removeToken } from "../../domains/push/push.ts";
import type { PushPlatform } from "../../types/push.ts";

const tokenBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: { token: { type: "string", minLength: 1, maxLength: 255 } },
} as const;

const registerBody = {
  type: "object",
  required: ["token", "platform"],
  additionalProperties: false,
  properties: {
    token: { type: "string", minLength: 1, maxLength: 255 },
    platform: { type: "string", enum: ["ios", "android"] },
  },
} as const;

export function pushRoutes(app: FastifyInstance) {
  app.post<{ Body: { token: string; platform: PushPlatform } }>(
    "/me/push-tokens",
    { schema: { body: registerBody }, preHandler: app.authenticate },
    async (request) => {
      await registerToken(
        request.authenticated!.user.id,
        request.body.token,
        request.body.platform,
      );
      return { ok: true };
    },
  );

  app.delete<{ Body: { token: string } }>(
    "/me/push-tokens",
    { schema: { body: tokenBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const removed = await removeToken(request.authenticated!.user.id, request.body.token);
      if (!removed) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );
}
