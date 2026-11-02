import type { FastifyInstance } from "fastify";
import { findByUsername, type PublicUser } from "../auth/identity.ts";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";

const addByUsernameBody = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: { username: { type: "string" } },
} as const;
export function contactRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  app.post<{
    Body: {
      username: string;
    };
  }>(
    "/me/contacts",
    { preHandler: app.authenticate, schema: { body: addByUsernameBody } },
    async (request, reply) => {
      const contact = await findByUsername(request.body.username);
      if (!contact) return reply.code(404).send(notFound);
      if (contact.id === request.user.id) {
        return reply.code(400).send({ error: "cannot add yourself" });
      }
      await sql`
        insert into contacts (owner_id, contact_id)
        values (${request.user.id}, ${contact.id})
        on conflict do nothing
      `;
      return contact;
    },
  );
  app.get("/me/contacts", { preHandler: app.authenticate }, async (request) => {
    return sql<PublicUser[]>`
      select u.id, u.username, u.name
      from contacts c
      join users u on u.id = c.contact_id
      where c.owner_id = ${request.user.id}
      order by u.username, u.id
    `;
  });
  app.delete<{
    Params: {
      userId: string;
    };
  }>("/me/contacts/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId } = request.params;
    if (!uuidPattern.test(userId)) return reply.code(404).send(notFound);
    const removed = await sql`
        delete from contacts
        where owner_id = ${request.user.id} and contact_id = ${userId}
        returning contact_id
      `;
    if (removed.length === 0) return reply.code(404).send(notFound);
    return { ok: true };
  });
}
