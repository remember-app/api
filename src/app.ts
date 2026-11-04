import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { config } from "./config.ts";
import { codeForStatus, fail } from "./http/errors.ts";
import { registerRoutes } from "./http/index.ts";

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify({ logger: !config.server.isTest(), ...options });

  app.get("/health", () => ({ status: "ok" }));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
      return fail(reply, 500, "internal");
    }
    if (error.validation) {
      return fail(reply, 400, "bad_request", { validation: error.validation });
    }
    return fail(reply, status, codeForStatus(status));
  });

  app.setNotFoundHandler((_request, reply) => fail(reply, 404, "not_found"));

  registerRoutes(app);

  return app;
}
