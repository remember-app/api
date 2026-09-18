import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { audienceOf, type Provider, type ProviderClaims, verifier } from "./providers.ts";
import { type AuthUser, issue } from "./session.ts";

/**
 * Spelled out rather than a named format: ajv's loose formats accept strings
 * the rest of the stack does not. The ceiling is far above any id token either
 * provider mints and keeps a megabyte of noise away from the parser.
 */
const idTokenBody = {
  type: "object",
  required: ["idToken"],
  additionalProperties: false,
  properties: { idToken: { type: "string", minLength: 1, maxLength: 8192 } },
} as const;

/**
 * The user behind a provider account, made on first sighting.
 *
 * Bound by `sub` and by nothing else: a matching email never joins two
 * accounts. Apple's private relay address can change and can be handed out
 * again, so merging on it would eventually sign somebody into a stranger's
 * account — and the same trust would let any provider that lets an address go
 * unverified take over an account by claiming it.
 */
async function findOrCreateUser(provider: Provider, claims: ProviderClaims): Promise<AuthUser> {
  return sql.begin(async (tx) => {
    // Serializes find-or-create per provider account, exactly as the email flow
    // does per address: two concurrent sign-ins would otherwise race for the
    // auth_identities primary key.
    await tx`select pg_advisory_xact_lock(hashtext(${`${provider}:${claims.sub}`}))`;
    const [found] = await tx<AuthUser[]>`
      select u.id, u.username, u.name, u.email, u.language
      from auth_identities i join users u on u.id = i.user_id
      where i.provider = ${provider} and i.provider_account_id = ${claims.sub}
    `;
    if (found) return found;
    // What the token carried, and null where it carried nothing. The profile is
    // written at creation only: a later sign-in must not overwrite a name the
    // person has since changed here.
    //
    // `email` here is profile text and nothing more. Nobody may look a user up
    // by it, invite by it or trust it as proof of anything: it can be an Apple
    // relay, and a provider that never verified it would otherwise hand over
    // whichever account claimed that address first.
    const [user] = await tx<AuthUser[]>`
      insert into users (name, email) values (${claims.name}, ${claims.email})
      returning id, username, name, email, language
    `;
    if (!user) throw new Error("insert into users returned no row");
    await tx`
      insert into auth_identities (user_id, provider, provider_account_id)
      values (${user.id}, ${provider}, ${claims.sub})
    `;
    return user;
  });
}

/**
 * Sign-in with an id token the app already obtained from Apple or Google. The
 * server does no dance with the provider — it verifies what it is handed and
 * turns it into one of our sessions. The answer is `/auth/email/verify`'s
 * answer to the character, so the app reads one shape for all three providers.
 *
 * Mounted from `buildApp` beside `identityRoutes`.
 */
export function socialRoutes(app: FastifyInstance) {
  for (const provider of ["apple", "google"] as const) {
    app.post<{ Body: { idToken: string } }>(
      `/auth/${provider}`,
      { schema: { body: idTokenBody } },
      async (request, reply) => {
        // Without a client id there is no audience to check a token against,
        // and a provider that cannot be checked is not merely misconfigured for
        // this request — it is off. Says so plainly instead of failing as if
        // the caller's token were bad.
        if (!audienceOf(provider)) {
          return reply.code(501).send({ error: "provider not configured" });
        }
        let claims: ProviderClaims;
        try {
          claims = await verifier.verify(provider, request.body.idToken);
        } catch (error) {
          // One answer for every way a token can fail to verify — bad
          // signature, wrong audience, wrong issuer, expired, malformed,
          // unknown key. Which one it was is the caller's business only in the
          // log; telling a stranger sharpens forgery and nothing else.
          //
          // ponytail: a JWKS fetch that fails (provider outage) lands here too
          // and reads as a bad token. Split it out as a 503 if the log ever
          // shows that happening for real.
          request.log.info({ err: error, provider }, "id token rejected");
          return reply.code(401).send({ error: "invalid token" });
        }
        const user = await findOrCreateUser(provider, claims);
        return { token: await issue(user.id), user };
      },
    );
  }
}
