import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { analyzeItems } from "../../services/media/analysis.ts";
import type { ProjectId, ProjectItemId } from "../../types/id.ts";
import { fail } from "../errors.ts";
import { allow } from "../rate-limit.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const analyzeBody = {
  type: "object",
  required: ["itemIds"],
  additionalProperties: false,
  properties: {
    itemIds: {
      type: "array",
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: { type: "string" },
    },
  },
} as const;

type ProjectParams = { projectId: string };

export function analysisRoutes(app: FastifyInstance) {
  app.post<{ Params: ProjectParams; Body: { itemIds: string[] } }>(
    "/projects/:projectId/analyze",
    { schema: { body: analyzeBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const projectId = request.params.projectId;
      if (!uuidPattern.test(projectId)) return fail(reply, 404, "not_found");
      if (request.body.itemIds.some((id) => !uuidPattern.test(id))) {
        return fail(reply, 400, "bad_request");
      }
      if (
        !allow(
          "montages",
          request.authenticated!.user.id,
          config.rate.montages(),
          config.rate.windowMs(),
        )
      ) {
        return fail(reply, 429, "capacity_exceeded");
      }
      const result = await analyzeItems(
        projectId as ProjectId,
        request.authenticated!.user.id,
        request.body.itemIds as ProjectItemId[],
      );
      if ("denial" in result) {
        if (result.denial === "forbidden") return fail(reply, 403, "forbidden");
        if (result.denial === "not_found") return fail(reply, 404, "not_found");
        return fail(reply, 409, "capacity_exceeded");
      }
      return result;
    },
  );
}
