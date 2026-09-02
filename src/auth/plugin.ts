import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { rateMaxPerEmail, rateMaxPerIp, rateWindowMs } from "./config.ts";
import { consumeEmailLoginToken, deepLink, normalizeEmail, startEmailLogin } from "./email.ts";
import { type AuthUser, issue, verify } from "./session.ts";

declare module "fastify" {
  interface FastifyInstance {
    /** The session check: `app.get("/x", { preHandler: app.authenticate }, ...)`. */
    authenticate: preHandlerAsyncHookHandler;
  }
  interface FastifyRequest {
    /** Populated only behind `app.authenticate` — without it there is nothing to read. */
    user: AuthUser;
  }
}

const emailBody = {
  type: "object",
  required: ["email"],
  additionalProperties: false,
  // maxLength is the RFC 5321 ceiling on an address; format rejects a malformed
  // one. Fastify's ajv runs with removeAdditional, so additionalProperties here
  // strips unknown fields rather than refusing the body.
  properties: { email: { type: "string", format: "email", maxLength: 254 } },
} as const;

const tokenBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: { token: { type: "string", minLength: 1, maxLength: 512 } },
} as const;

/**
 * Email sign-in and the session check. Called directly rather than through
 * `app.register`: Fastify encapsulates plugins, so `authenticate` decorated
 * inside a registered one would be invisible outside it. Here it lands on the
 * root instance and every route can mount it.
 */
export function authPlugin(app: FastifyInstance) {
  // ponytail: window kept in process memory — the pilot runs a single instance.
  // Once there are several (or a proxy in front), move the counter to Redis or
  // @fastify/rate-limit with a store, and turn on trustProxy, otherwise
  // request.ip is the proxy's address.
  const hits = new Map<string, number>();
  let windowStart = 0;

  /**
   * Address and IP are counted apart, against different abuses and so with
   * different ceilings: the address one keeps a stranger from enumerating who
   * is registered, the IP one is a coarse backstop that must stay loose enough
   * for a whole office behind one address.
   */
  const rateLimited = (buckets: [key: string, max: number][]) => {
    const now = Date.now();
    // Fixed window rather than sliding: it lets through up to 2× across a
    // boundary, but the counters clear themselves on rollover. Within one
    // window the map holds an entry per distinct key seen.
    if (now - windowStart >= rateWindowMs()) {
      hits.clear();
      windowStart = now;
    }
    let limited = false;
    for (const [key, max] of buckets) {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      if (n > max) limited = true;
    }
    return limited;
  };

  // The counter keys on the mailbox, not the alias: `me+anything@x` is one
  // inbox, so subaddressing must not hand out a fresh budget per tag.
  // ponytail: RFC 5233 `+tag` only. Gmail's dot-folding is provider-specific
  // and locks people out when guessed wrong — add it if aliasing shows up.
  const mailbox = (email: string) => email.replace(/\+[^@]*(?=@)/, "");

  app.decorate("authenticate", async (request, reply) => {
    const header = request.headers.authorization ?? "";
    // RFC 7235 makes the scheme case-insensitive; clients do send `bearer`.
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const user = token ? await verify(token) : null;
    if (!user) {
      reply.code(401).send({ error: "unauthorized" });
      // Returning the reply tells Fastify the response is already out, so the
      // route handler is never called.
      return reply;
    }
    request.user = user;
  });

  app.post<{ Body: { email: string } }>(
    "/auth/email/start",
    { schema: { body: emailBody } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const buckets: [string, number][] = [
        [`email:${mailbox(email)}`, rateMaxPerEmail()],
        [`ip:${request.ip}`, rateMaxPerIp()],
      ];
      if (rateLimited(buckets)) {
        return reply.code(429).send({ error: "too many requests" });
      }
      const token = await startEmailLogin(email);
      // ponytail: the link is delivered to the log. There is no mail service in
      // the MVP; sending the mail belongs right here, and the token stops
      // leaking into the logs the moment it exists.
      request.log.info({ email, link: deepLink(token) }, "magic link issued");
      // The answer is the same for a fresh address and a known one — otherwise
      // this route answers the question "is this person registered with you?".
      return { ok: true };
    },
  );

  app.post<{ Body: { token: string } }>(
    "/auth/email/verify",
    { schema: { body: tokenBody } },
    async (request, reply) => {
      const user = await consumeEmailLoginToken(request.body.token);
      if (!user) return reply.code(401).send({ error: "invalid or expired token" });
      return { token: await issue(user.id), user };
    },
  );

  app.get("/me", { preHandler: app.authenticate }, async (request) => request.user);
}
