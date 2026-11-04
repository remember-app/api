import type { FastifyInstance } from "fastify";
import {
  addContact,
  listContacts,
  removeContact,
  renameContact,
} from "../../domains/contact/contact.ts";
import { findByUsername } from "../../domains/user/user.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import type { UserId } from "../../types/id.ts";
import { fail } from "../errors.ts";

const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const addBody = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: {
    username: { type: "string", minLength: 3, maxLength: 30 },
    name: { type: ["string", "null"], maxLength: 200 },
  },
} as const;

const renameBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: ["string", "null"], maxLength: 200 } },
} as const;

export function contactRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/me/contacts",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request) => {
      const { limit, offset } = pageOf(request.query);
      return listContacts(request.authenticated!.user.id, limit, offset);
    },
  );

  app.post<{ Body: { username: string; name?: string | null } }>(
    "/me/contacts",
    { schema: { body: addBody }, preHandler: app.authenticate },
    async (request, reply) => {
      const target = await findByUsername(request.body.username);
      if (!target) return fail(reply, 404, "not_found");
      if (target.id === request.authenticated!.user.id) {
        return fail(reply, 400, "bad_request");
      }
      return addContact(request.authenticated!.user.id, target.id, request.body.name ?? null);
    },
  );

  app.patch<{ Params: { userId: string }; Body: { name: string | null } }>(
    "/me/contacts/:userId",
    { schema: { body: renameBody }, preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.userId)) {
        return fail(reply, 404, "not_found");
      }
      const contact = await renameContact(
        request.authenticated!.user.id,
        request.params.userId as UserId,
        request.body.name,
      );
      if (!contact) return fail(reply, 404, "not_found");
      return contact;
    },
  );

  app.delete<{ Params: { userId: string } }>(
    "/me/contacts/:userId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.userId)) {
        return fail(reply, 404, "not_found");
      }
      const removed = await removeContact(
        request.authenticated!.user.id,
        request.params.userId as UserId,
      );
      if (!removed) return fail(reply, 404, "not_found");
      return { ok: true };
    },
  );
}
