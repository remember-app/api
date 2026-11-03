import type { FastifyInstance } from "fastify";
import { setName, setUsername, usernameAvailable } from "../../domains/user/user.ts";

const usernameBody = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: { username: { type: "string", minLength: 3, maxLength: 30 } },
} as const;

const usernameQuery = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: { username: { type: "string", minLength: 3, maxLength: 30 } },
} as const;

const nameBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: ["string", "null"], maxLength: 200 } },
} as const;

export function meRoutes(app: FastifyInstance) {
  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    return request.authenticated!.user;
  });

  app.get<{ Querystring: { username: string } }>(
    "/me/username/available",
    { schema: { querystring: usernameQuery }, preHandler: app.authenticate },
    async (request) => {
      return {
        available: await usernameAvailable(request.query.username, request.authenticated!.user.id),
      };
    },
  );

  app.post<{ Body: { username: string } }>(
    "/me/username",
    { schema: { body: usernameBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const result = await setUsername(request.authenticated!.user.id, request.body.username);
      if ("denial" in result) {
        if (result.denial === "taken") return reply.code(409).send({ error: "conflict" });
        if (result.denial === "not_found") return reply.code(404).send({ error: "not_found" });
        return reply.code(400).send({ error: "bad_request" });
      }
      return result.user;
    },
  );

  app.post<{ Body: { name: string | null } }>(
    "/me/name",
    { schema: { body: nameBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = await setName(request.authenticated!.user.id, request.body.name);
      if (!user) return reply.code(404).send({ error: "not_found" });
      return user;
    },
  );
}
