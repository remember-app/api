import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { audienceOf, type Provider, type ProviderClaims, verifier } from "./providers.ts";
import { type AuthUser, issue, profileColumns } from "./session.ts";

const idTokenBody = {
  type: "object",
  required: ["idToken"],
  additionalProperties: false,
  properties: { idToken: { type: "string", minLength: 1, maxLength: 8192 } },
} as const;
async function findOrCreateUser(provider: Provider, claims: ProviderClaims): Promise<AuthUser> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`${provider}:${claims.sub}`}))`;
    const [found] = await tx<AuthUser[]>`
      select ${profileColumns}
      from auth_identities i join users u on u.id = i.user_id
      where i.provider = ${provider} and i.provider_account_id = ${claims.sub}
    `;
    if (found) return found;
    const [user] = await tx<AuthUser[]>`
      insert into users as u (name, email) values (${claims.name}, ${claims.email})
      returning ${profileColumns}
    `;
    if (!user) throw new Error("insert into users returned no row");
    await tx`
      insert into auth_identities (user_id, provider, provider_account_id)
      values (${user.id}, ${provider}, ${claims.sub})
    `;
    return user;
  });
}
export function socialRoutes(app: FastifyInstance) {
  app.get("/auth/methods", (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return { email: true, apple: !!audienceOf("apple"), google: !!audienceOf("google") };
  });
  for (const provider of ["apple", "google"] as const) {
    app.post<{
      Body: {
        idToken: string;
      };
    }>(`/auth/${provider}`, { schema: { body: idTokenBody } }, async (request, reply) => {
      if (!audienceOf(provider)) {
        return reply.code(501).send({ error: "provider not configured" });
      }
      let claims: ProviderClaims;
      try {
        claims = await verifier.verify(provider, request.body.idToken);
      } catch (error) {
        request.log.info({ err: error, provider }, "id token rejected");
        return reply.code(401).send({ error: "invalid token" });
      }
      const user = await findOrCreateUser(provider, claims);
      return { token: await issue(user.id), user };
    });
  }
}
