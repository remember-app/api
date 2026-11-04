import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { config } from "../../config.ts";
import { verifySession } from "../../domains/auth/auth.ts";
import { getUser } from "../../domains/user/user.ts";
import type { AuthSession } from "../../types/auth.ts";
import type { User } from "../../types/user.ts";
import { fail } from "../errors.ts";
import { allow } from "../rate-limit.ts";

export type Authenticated = {
  user: User;
  session: AuthSession;
  token: string;
};

declare module "fastify" {
  interface FastifyRequest {
    authenticated: Authenticated | null;
  }
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
  }
}

const bearer = (header = "") =>
  header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

export function authPlugin(app: FastifyInstance) {
  app.decorateRequest("authenticated", null);
  app.decorate("authenticate", async (request, reply) => {
    const token = bearer(request.headers.authorization);
    if (!token) return fail(reply, 401, "unauthorized");
    const session = await verifySession(token);
    if (!session) return fail(reply, 401, "unauthorized");
    const user = await getUser(session.userId);
    if (!user) return fail(reply, 401, "unauthorized");
    if (request.method !== "GET" && request.method !== "HEAD") {
      const within = allow("write", user.id, config.rate.write(), config.rate.windowMs());
      if (!within) return fail(reply, 429, "limit_exceeded");
    }
    request.authenticated = { user, session, token };
  });
}
