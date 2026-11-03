import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { verifySession } from "../../domains/auth/auth.ts";
import { getUser } from "../../domains/user/user.ts";
import type { AuthSession } from "../../types/auth.ts";
import type { User } from "../../types/user.ts";

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
    if (!token) return reply.code(401).send({ error: "unauthorized" });
    const session = await verifySession(token);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    const user = await getUser(session.userId);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    request.authenticated = { user, session, token };
  });
}
