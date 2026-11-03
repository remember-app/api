import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import {
  type AuthUser,
  bearerToken,
  hashToken,
  type Language,
  profileColumns,
  revoke,
  revokeByToken,
} from "./session.ts";

const usernamePattern = "^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,28}[a-zA-Z0-9]$";
const usernameRegex = new RegExp(usernamePattern, "u");
const usernameProposal = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: { username: { type: "string", pattern: usernamePattern } },
} as const;
const languageChoice = {
  type: "object",
  required: ["language"],
  additionalProperties: false,
  properties: { language: { type: "string", enum: ["ru", "en"] } },
} as const;
const datesBetweenDaysChoice = {
  type: "object",
  required: ["dates_between_days"],
  additionalProperties: false,
  properties: { dates_between_days: { enum: [true, false] } },
} as const;
const lookupQuery = {
  type: "object",
  required: ["username"],
  additionalProperties: false,
  properties: { username: { type: "string" } },
} as const;
const sessionParams = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" },
  },
} as const;

import type { PublicUser } from "../types/user.ts";

export type { PublicUser };
export async function findByUsername(username: string): Promise<PublicUser | undefined> {
  if (!usernameRegex.test(username)) return undefined;
  const [user] = await sql<PublicUser[]>`
    select id, username, name from users where username = ${username}
  `;
  return user;
}
export function identityRoutes(app: FastifyInstance) {
  app.post("/me/consent", { preHandler: app.authenticate }, async (request) => {
    const [user] = await sql<
      {
        consent_accepted_at: Date;
      }[]
    >`
      update users set consent_accepted_at = coalesce(consent_accepted_at, now())
      where id = ${request.user.id}
      returning consent_accepted_at
    `;
    if (!user) throw new Error("update users returned no row");
    return { accepted_at: user.consent_accepted_at };
  });
  app.post<{
    Body: {
      username: string;
    };
  }>(
    "/me/username",
    { preHandler: app.authenticate, schema: { body: usernameProposal } },
    async (request, reply) => {
      try {
        const [user] = await sql<AuthUser[]>`
          update users u set username = ${request.body.username}
          where id = ${request.user.id}
            and (username is not null or consent_accepted_at is not null)
          returning ${profileColumns}
        `;
        if (!user) return reply.code(403).send({ error: "consent required" });
        return user;
      } catch (error) {
        if (
          (
            error as {
              code?: string;
            }
          ).code === "23505"
        ) {
          return reply.code(409).send({ error: "username taken" });
        }
        throw error;
      }
    },
  );
  app.get<{
    Querystring: {
      username: string;
    };
  }>(
    "/me/username/available",
    { preHandler: app.authenticate, schema: { querystring: usernameProposal } },
    async (request) => {
      const holder = await findByUsername(request.query.username);
      return { available: !holder || holder.id === request.user.id };
    },
  );
  app.post<{
    Body: {
      language: Language;
    };
  }>(
    "/me/language",
    { preHandler: app.authenticate, schema: { body: languageChoice } },
    async (request) => {
      const [user] = await sql<AuthUser[]>`
        update users u set language = ${request.body.language}
        where id = ${request.user.id}
        returning ${profileColumns}
      `;
      if (!user) throw new Error("update users returned no row");
      return user;
    },
  );
  app.post<{
    Body: {
      dates_between_days: boolean;
    };
  }>(
    "/me/dates-between-days",
    { preHandler: app.authenticate, schema: { body: datesBetweenDaysChoice } },
    async (request) => {
      const [user] = await sql<AuthUser[]>`
        update users u set dates_between_days = ${request.body.dates_between_days}
        where id = ${request.user.id}
        returning ${profileColumns}
      `;
      if (!user) throw new Error("update users returned no row");
      return user;
    },
  );
  app.get<{
    Querystring: {
      username: string;
    };
  }>(
    "/users",
    { preHandler: app.authenticate, schema: { querystring: lookupQuery } },
    async (request, reply) => {
      const user = await findByUsername(request.query.username);
      if (!user) return reply.code(404).send({ error: "not found" });
      return user;
    },
  );
  app.get("/auth/sessions", { preHandler: app.authenticate }, async (request) => {
    const current = hashToken(bearerToken(request.headers.authorization));
    return sql`
      select id, created_at, expires_at, token_hash = ${current} as current
      from sessions
      where user_id = ${request.user.id} and revoked_at is null and expires_at > now()
      order by created_at desc
    `;
  });
  app.post<{
    Params: {
      id: string;
    };
  }>(
    "/auth/sessions/:id/revoke",
    { preHandler: app.authenticate, schema: { params: sessionParams } },
    async (request, reply) => {
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
