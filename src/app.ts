import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { config } from "./config.ts";
import { registerRoutes } from "./http/index.ts";

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify({ logger: !config.server.isTest(), ...options });

  app.get("/health", () => ({ status: "ok" }));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send(error);
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "internal" });
  });

  registerRoutes(app);

  return app;
}
