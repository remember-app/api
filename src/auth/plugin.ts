import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import {
  devEmailBypass,
  env,
  rateMaxPerEmail,
  rateMaxPerIp,
  rateWindowMs,
  reviewLogin,
} from "./config.ts";
import { normalizeEmail, startEmailLogin, verifyEmailLoginCode } from "./email.ts";
import { mailConfigured, sendLoginCode } from "./mail.ts";
import { type AuthUser, bearerToken, issue, type Language, verify } from "./session.ts";

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
  properties: {
    email: { type: "string", format: "email", maxLength: 254 },
    // The language the letter is written in — the caller's own, since there is
    // no session here to read one from. An enum and not a free string: a value
    // outside the two is a bug in the client, and 400 says so rather than
    // quietly posting the wrong letter. Absent means Russian, as before.
    language: { type: "string", enum: ["ru", "en"] },
  },
} as const;

/**
 * The address as well as the code: the code is the secret, but it is only the
 * secret *of an address* — a million codes shared by everybody signing in at
 * once would otherwise let a guess collide with whoever it happened to fit.
 *
 * `pattern` and not a loose string: six digits is the whole shape, and a body
 * that is not that shape is turned away before it reaches a deliberately slow
 * hash. Everything past that shape — wrong digits, expired, spent — is one 401.
 */
const codeBody = {
  type: "object",
  required: ["email", "code"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email", maxLength: 254 },
    code: { type: "string", pattern: "^[0-9]{6}$" },
  },
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

  /**
   * The counter keys on the mailbox, not the alias: `me+anything@x` is one
   * inbox, so subaddressing must not hand out a fresh budget per tag.
   *
   * `+tag` is RFC 5233 and safe everywhere. Dots are not — in a plain address
   * they are significant, and folding them would put two different people in
   * one bucket — so that fold is made only for the one provider that documents
   * ignoring them, Gmail, which also serves `googlemail.com` from the same
   * inbox. Without it `a.b@`, `ab@` and `a.b.c@gmail.com` are one inbox with
   * three budgets, and since cfa638e the overflow is not a log line any more
   * but real letters into somebody's mail.
   *
   * The account itself is keyed on `normalizeEmail` and is not touched by any
   * of this: a coarser bucket can only ever cost an extra wait, never a login.
   */
  const mailbox = (email: string) => {
    const plain = email.replace(/\+[^@]*(?=@)/, "");
    const [local, domain] = plain.split("@");
    if (local === undefined || (domain !== "gmail.com" && domain !== "googlemail.com")) {
      return plain;
    }
    return `${local.replaceAll(".", "")}@gmail.com`;
  };

  // Read here and not per request: a malformed value has to stop the server
  // starting, not surface on the reviewer's first sign-in.
  const review = reviewLogin();

  app.decorate("authenticate", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const user = token ? await verify(token) : null;
    if (!user) {
      reply.code(401).send({ error: "unauthorized" });
      // Returning the reply tells Fastify the response is already out, so the
      // route handler is never called.
      return reply;
    }
    request.user = user;
  });

  app.post<{ Body: { email: string; language?: Language } }>(
    "/auth/email/start",
    { schema: { body: emailBody } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      // The development way in that does not need a mail provider — a build in
      // somebody's hands has to have one — and it is deliberately narrow: the
      // switch explicitly on, the address on test.test, and not production.
      // Any of the three missing and the request takes the ordinary path: a
      // real letter, or 503 below when there is nothing to post it through.
      //
      // It used to be «NODE_ENV is not production», which is a door that opens
      // itself: a variable nobody set on a machine nobody was thinking about
      // handed a session for any address to whoever typed it. Absence now
      // means closed on all three counts, which is what a lock has to mean.
      //
      // `NODE_ENV` is read through `env` and case-folded, unlike every other
      // reader of it: `--env-file` trims and unquotes what it parses, but a
      // value handed in by a shell, a unit file or a hosting panel arrives
      // raw, so `production ` and `Production` are both things a person can
      // type once and never see again — and each spelling missed here would
      // be a production server with the bypass live. Matched on the `prod`
      // prefix for that same reason: `prod` is what a person writes when the
      // box is one, and a backstop that only knows the long spelling is not
      // standing where it was put.
      //
      // `.test` is one of the four names RFC 2606 reserves forever, so
      // `test.test` is nobody's to register and will never be anybody's mail
      // server — an address here cannot be a real person's, whoever types it.
      // That is why the door is on this domain and not on a name somebody
      // owns: a domain we merely believe is unused can grow a mailbox, and
      // then a code meant for a developer is delivered to its owner.
      //
      // The domain is matched on the whole `@test.test` tail, after
      // `normalizeEmail` has folded the case: `someone@evil.test.test` is a
      // different domain and must not pass as this one.
      const bypass =
        devEmailBypass() &&
        email.endsWith("@test.test") &&
        !env("NODE_ENV")?.toLowerCase().startsWith("prod");
      // The review door (see `reviewLogin`), apart from the lock above and
      // blind to both of its switches. Matched on the address exactly as it
      // came, not as `normalizeEmail` folds it: another case, a `+tag` or a
      // neighbour is somebody else and takes the ordinary path. Past this line
      // it is an ordinary sign-in whose code happens to be fixed — the same
      // limiter, expiry and attempts, the same answer — only no letter.
      const reviewer = review !== undefined && request.body.email === review.email;
      // With no mail keys the letter cannot go at all, and without one of the
      // two doors there is nothing else to answer with — so the request ends
      // here, before the limiter and before the user is made, so nothing is
      // written down and nobody's budget is spent on being told so.
      if (!mailConfigured() && !bypass && !reviewer) {
        return reply.code(503).send({ error: "mail not configured" });
      }
      const buckets: [string, number][] = [
        [`email:${mailbox(email)}`, rateMaxPerEmail()],
        [`ip:${request.ip}`, rateMaxPerIp()],
      ];
      if (rateLimited(buckets)) {
        return reply.code(429).send({ error: "too many requests" });
      }
      const code = await startEmailLogin(email, reviewer ? review.code : undefined);
      if (reviewer) {
        // Neither the address nor the code: the line says the door was used,
        // and the request id pino puts on it says by which request.
        request.log.warn("review login code issued");
        return { ok: true };
      }
      // The development door decided above: the same code the letter would
      // have carried is handed straight back to whoever asked. Mail keys make
      // no difference here — a letter to test.test has nowhere to be
      // delivered, the domain being reserved rather than merely idle, and a
      // dev machine that happens to hold real keys should not start bouncing.
      if (bypass) return { ok: true, code };
      try {
        await sendLoginCode(email, code, request.body.language);
      } catch (error) {
        // The mail server's own words go to the log and no further. 502 and not
        // 500: nothing here failed, the thing behind us did — and it is not
        // 4xx either, because the address was never the problem. The code
        // stays minted and simply expires; a retry mints another.
        request.log.error({ err: error, email }, "login code not sent");
        return reply.code(502).send({ error: "mail delivery failed" });
      }
      // The code itself is never logged: it is a bearer credential for the
      // account, and a log line holding it is one copy too many now that there
      // is a real way to deliver it.
      request.log.info({ email }, "login code sent");
      // The answer is the same for a fresh address and a known one — otherwise
      // this route answers the question "is this person registered with you?".
      return { ok: true };
    },
  );

  app.post<{ Body: { email: string; code: string } }>(
    "/auth/email/verify",
    { schema: { body: codeBody } },
    async (request, reply) => {
      // Normalized the same way `/auth/email/start` normalizes it, and through
      // the same function: the address is the key the code was filed under, so
      // a capital letter in what the person typed here must not make their own
      // code a stranger's.
      //
      // Not rate-limited of itself, and it does not need to be: a guess only
      // reaches the hash while a live code exists, each one spends one of that
      // code's few attempts, and minting codes is exactly what the limiter on
      // /auth/email/start counts. The guesses an address is worth in a window
      // are that limit times the attempt ceiling, and nothing here can widen
      // it.
      const user = await verifyEmailLoginCode(
        normalizeEmail(request.body.email),
        request.body.code,
      );
      // One answer for every way of failing — unknown address, wrong digits,
      // expired, already spent, attempts exhausted. A difference between them
      // is a hint about which half of the pair to keep working on.
      if (!user) return reply.code(401).send({ error: "invalid or expired code" });
      return { token: await issue(user.id), user };
    },
  );

  app.get("/me", { preHandler: app.authenticate }, async (request) => request.user);
}
