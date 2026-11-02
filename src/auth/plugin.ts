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
    authenticate: preHandlerAsyncHookHandler;
  }
  interface FastifyRequest {
    user: AuthUser;
  }
}
const emailBody = {
  type: "object",
  required: ["email"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email", maxLength: 254 },
    language: { type: "string", enum: ["ru", "en"] },
  },
} as const;
const codeBody = {
  type: "object",
  required: ["email", "code"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email", maxLength: 254 },
    code: { type: "string", pattern: "^[0-9]{6}$" },
  },
} as const;
export function authPlugin(app: FastifyInstance) {
  const hits = new Map<string, number>();
  let windowStart = 0;
  const rateLimited = (buckets: [key: string, max: number][]) => {
    const now = Date.now();
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
  const mailbox = (email: string) => {
    const plain = email.replace(/\+[^@]*(?=@)/, "");
    const [local, domain] = plain.split("@");
    if (local === undefined || (domain !== "gmail.com" && domain !== "googlemail.com")) {
      return plain;
    }
    return `${local.replaceAll(".", "")}@gmail.com`;
  };
  const review = reviewLogin();
  app.decorate("authenticate", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const user = token ? await verify(token) : null;
    if (!user) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    request.user = user;
  });
  app.post<{
    Body: {
      email: string;
      language?: Language;
    };
  }>("/auth/email/start", { schema: { body: emailBody } }, async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    const bypass =
      devEmailBypass() &&
      email.endsWith("@test.test") &&
      !env("NODE_ENV")?.toLowerCase().startsWith("prod");
    const reviewer = review !== undefined && request.body.email === review.email;
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
      request.log.warn("review login code issued");
      return { ok: true };
    }
    if (bypass) return { ok: true, code };
    try {
      await sendLoginCode(email, code, request.body.language);
    } catch (error) {
      request.log.error({ err: error, email }, "login code not sent");
      return reply.code(502).send({ error: "mail delivery failed" });
    }
    request.log.info({ email }, "login code sent");
    return { ok: true };
  });
  app.post<{
    Body: {
      email: string;
      code: string;
    };
  }>("/auth/email/verify", { schema: { body: codeBody } }, async (request, reply) => {
    const user = await verifyEmailLoginCode(normalizeEmail(request.body.email), request.body.code);
    if (!user) return reply.code(401).send({ error: "invalid or expired code" });
    return { token: await issue(user.id), user };
  });
  app.get("/me", { preHandler: app.authenticate }, async (request) => request.user);
}
