import type { FastifyInstance } from "fastify";
import { findByUsername, type PublicUser } from "../auth/identity.ts";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";

/**
 * The same shape `inviteByUsernameBody` uses, and for the same reason: what
 * may be *asked for* is settled by the rule that governs what may be *held*
 * (`findByUsername`), so a name nobody could ever register answers 404 rather
 * than 400. Saving somebody is the same act as inviting them, one step earlier.
 */
const addByUsernameBody = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: { username: { type: "string" } },
} as const;

/**
 * The caller's own list of usernames they invite from (doc-10). One way: the
 * person saved is not told, not asked, and the row grants them nothing — no
 * access, no visibility, no reciprocity. Everything here is keyed on
 * `request.user.id` and on nothing else, which is the whole privacy rule: no
 * role and no membership can reach another person's list.
 *
 * Mounted from `buildApp` after `authPlugin` — `app.authenticate` is all these
 * routes need. Under `/me` for the reason the username routes are: the answer
 * is about the caller, and there is no other list to ask for.
 */
export function contactRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };

  app.post<{ Body: { username: string } }>(
    "/me/contacts",
    { preHandler: app.authenticate, schema: { body: addByUsernameBody } },
    async (request, reply) => {
      const contact = await findByUsername(request.body.username);
      if (!contact) return reply.code(404).send(notFound);
      // Before the insert, so that the CHECK never has to answer this: adding
      // yourself is a mistake in the app worth naming, not «нет такого ника».
      if (contact.id === request.user.id) {
        return reply.code(400).send({ error: "cannot add yourself" });
      }

      // Saving the same person twice is the same row, so it is not an error —
      // the app offers «сохранить» next to anyone it did not recognise, and
      // tapping it on somebody already saved must simply do nothing.
      await sql`
        insert into contacts (owner_id, contact_id)
        values (${request.user.id}, ${contact.id})
        on conflict do nothing
      `;
      // The three fields `GET /users` hands out and no more — one user shape
      // for the client, and deliberately no email.
      return contact;
    },
  );

  app.get("/me/contacts", { preHandler: app.authenticate }, async (request) => {
    // By username rather than by when it was saved: this list is scanned by
    // eye and searched on the client, and an order that reshuffles between
    // visits is the thing that makes «лень искать» — the very reason the list
    // exists — come back. citext sorts case-insensitively, so `Ann` and `anna`
    // land where the eye expects them.
    return sql<PublicUser[]>`
      select u.id, u.username, u.name
      from contacts c
      join users u on u.id = c.contact_id
      where c.owner_id = ${request.user.id}
      order by u.username, u.id
    `;
  });

  app.delete<{ Params: { userId: string } }>(
    "/me/contacts/:userId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { userId } = request.params;
      // «Не uuid» is not a contact either. Checked here rather than in a params
      // schema, as in `DELETE /memories/:memoryId/members/:userId`: the house
      // rule for removing a person from a list is 404, and a schema would
      // answer 400 — besides, an unchecked value reaches Postgres as a cast
      // failure and comes back a 500.
      if (!uuidPattern.test(userId)) return reply.code(404).send(notFound);

      // `owner_id` is the caller's and cannot be anything else, so somebody
      // else's contact deletes nothing and answers exactly as one that was
      // never saved — the list must not confirm what is in another person's.
      const removed = await sql`
        delete from contacts
        where owner_id = ${request.user.id} and contact_id = ${userId}
        returning contact_id
      `;
      if (removed.length === 0) return reply.code(404).send(notFound);
      return { ok: true };
    },
  );
}
