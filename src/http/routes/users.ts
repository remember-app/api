import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { setLanguage, setName, setUsername } from "../../services/user/commands.ts";
import {
  accountView,
  findByUsername,
  listUsers,
  usernameAvailable,
} from "../../services/user/queries.ts";
import { fail } from "../errors.ts";

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

const languageBody = {
  type: "object",
  required: ["language"],
  additionalProperties: false,
  properties: { language: { type: "string", enum: ["en", "ru"] } },
} as const;

const nameBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: ["string", "null"], maxLength: 200 } },
} as const;

export function userRoutes(app: FastifyInstance) {
  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const account = await accountView(request.authenticated!.user.id);
    if (!account) return fail(reply, 404, "not_found");
    return account;
  });

  app.get<{ Params: { username: string } }>(
    "/users/:username",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = await findByUsername(request.params.username);
      if (!user) return fail(reply, 404, "not_found");
      return user;
    },
  );

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
        if (result.denial === "taken") return fail(reply, 409, "conflict");
        if (result.denial === "not_found") return fail(reply, 404, "not_found");
        return fail(reply, 400, "bad_request");
      }
      return result.user;
    },
  );

  app.post<{ Body: { name: string | null } }>(
    "/me/name",
    { schema: { body: nameBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = await setName(request.authenticated!.user.id, request.body.name);
      if (!user) return fail(reply, 404, "not_found");
      return user;
    },
  );

  app.post<{ Body: { language: "en" | "ru" } }>(
    "/me/language",
    { schema: { body: languageBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const user = await setLanguage(request.authenticated!.user.id, request.body.language);
      if (!user) return fail(reply, 404, "not_found");
      return user;
    },
  );

  if (!config.server.isProduction()) {
    app.get("/dev/users", { preHandler: app.authenticate }, async () => listUsers());
  }
}
