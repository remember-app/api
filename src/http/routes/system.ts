import type { FastifyInstance } from "fastify";
import { listSystemMedia } from "../../services/system/media.ts";

export function systemRoutes(app: FastifyInstance) {
  app.get("/system/media", async () => ({ items: await listSystemMedia() }));
}
