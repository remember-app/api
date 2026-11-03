import type { FastifyInstance } from "fastify";
import { getLimit } from "../../domains/limit/limit.ts";

export function limitRoutes(app: FastifyInstance) {
  app.get("/me/limits", { preHandler: app.authenticate }, async (request) => {
    return getLimit(request.authenticated!.user.id);
  });
}
