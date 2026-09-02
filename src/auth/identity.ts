import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { type AuthUser, bearerToken, hashToken, revoke, revokeByToken } from "./session.ts";

/**
 * Letters, digits and the separators `_ . -`; 3 to 30 long; a separator may
 * not sit at either edge. ASCII letters only, deliberately: a username is how
 * one person points at another to invite them, and `а` in Cyrillic is the same
 * glyph as `a` in Latin. citext folds case, not scripts, so a Unicode charset
 * would hand out flawless impersonation of anyone worth impersonating.
 *
 * Bounded on both sides, so there is no backtracking to feed a long string to.
 */
const usernamePattern = "^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,28}[a-zA-Z0-9]$";
const usernameRegex = new RegExp(usernamePattern, "u");

const usernameBody = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: { username: { type: "string", pattern: usernamePattern } },
} as const;

/**
 * Only "was the parameter given at all" — what may be *asked for* is settled
 * in the handler against the very rule that governs what may be *held*, so
 * that a string nobody could ever register answers 404 rather than 400.
 */
const lookupQuery = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: { username: { type: "string" } },
} as const;

/**
 * Spelled out rather than `format: "uuid"`: ajv's uuid format also accepts a
 * `urn:uuid:` prefix, which Postgres does not — that reached the database as
 * a cast failure and came back a 500.
 */
const sessionParams = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" },
  },
} as const;

/**
 * Managing one's own identity: the username, finding somebody by theirs, and
 * the sessions one is signed in through. Mounted from `buildApp` after
 * `authPlugin`, which is what puts `app.authenticate` on the instance.
 */
export function identityRoutes(app: FastifyInstance) {
  // Claims a username when there is none yet and changes it when there is —
  // one statement either way, because nothing distinguishes the two cases:
  // the old value is not kept anywhere (architecture.md: no history) and the
  // freed one is takeable by the next person the moment this commits.
  app.post<{ Body: { username: string } }>(
    "/me/username",
    { preHandler: app.authenticate, schema: { body: usernameBody } },
    async (request, reply) => {
      try {
        const [user] = await sql<AuthUser[]>`
          update users set username = ${request.body.username}
          where id = ${request.user.id}
          returning id, username, name, email
        `;
        if (!user) throw new Error("update users returned no row");
        return user;
      } catch (error) {
        // The citext unique index is the one constraint this statement can
        // break, so 23505 needs no further reading. Restyling one's own case
        // (`foo` -> `Foo`) never lands here: it is the same row.
        if ((error as { code?: string }).code === "23505") {
          return reply.code(409).send({ error: "username taken" });
        }
        throw error;
      }
    },
  );

  // Invite-by-username for memories: exact match, nothing else. Prefix and
  // fuzzy search are post-MVP, and would turn this into a directory of
  // everybody rather than a way to reach the person you already know.
  app.get<{ Querystring: { username: string } }>(
    "/users",
    { preHandler: app.authenticate, schema: { querystring: lookupQuery } },
    async (request, reply) => {
      // Screened against the rule that governs what may be held, because
      // citext is not the exact match it looks like: it folds through the
      // database's `lower()`, which maps U+212A KELVIN SIGN onto `k` and
      // `İ` onto `i` — so `KUBİKPROBE` would otherwise fetch `kubikprobe`.
      // Only ASCII can ever be registered, so anything else is a 404 by
      // definition. This also keeps a NUL byte away from Postgres, which
      // cannot compare one and answered 500.
      if (!usernameRegex.test(request.query.username)) {
        return reply.code(404).send({ error: "not found" });
      }
      // Past that screen citext does the one thing wanted of it — fold ASCII
      // case — and the unique index behind the column makes this a lookup
      // rather than a scan.
      const [user] = await sql<Pick<AuthUser, "id" | "username" | "name">[]>`
        select id, username, name from users where username = ${request.query.username}
      `;
      if (!user) return reply.code(404).send({ error: "not found" });
      // Deliberately three fields: enough to show who is about to be invited,
      // and no email — a username one may guess must not yield an address.
      return user;
    },
  );

  app.get("/auth/sessions", { preHandler: app.authenticate }, async (request) => {
    // `current` is settled here rather than carried out of the session check:
    // the token is already in hand, and hashing it again is cheaper than
    // widening what every authenticated request has to fetch.
    const current = hashToken(bearerToken(request.headers.authorization));
    return sql`
      select id, created_at, expires_at, token_hash = ${current} as current
      from sessions
      where user_id = ${request.user.id} and revoked_at is null and expires_at > now()
      order by created_at desc
    `;
  });

  app.post<{ Params: { id: string } }>(
    "/auth/sessions/:id/revoke",
    { preHandler: app.authenticate, schema: { params: sessionParams } },
    async (request, reply) => {
      // Ownership first, and it is the whole check: somebody else's session id
      // has to look exactly like one that was never issued. Deliberately not
      // narrowed to live rows — revoking twice is the same outcome as once.
      const [own] = await sql`
        select 1 from sessions where id = ${request.params.id} and user_id = ${request.user.id}
      `;
      if (!own) return reply.code(404).send({ error: "not found" });
      await revoke(request.params.id);
      return { ok: true };
    },
  );

  app.post("/auth/logout", { preHandler: app.authenticate }, async (request) => {
    await revokeByToken(bearerToken(request.headers.authorization));
    return { ok: true };
  });
}
