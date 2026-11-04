import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import { mailConfigured, sendLoginCode } from "../../integrations/mail/index.ts";
import { pageOf, pageQuerySchema } from "../../pagination.ts";
import {
  findOrCreateUser,
  issueSession,
  revokeSession,
  revokeSessionByToken,
  setLoginCode,
  verifyLoginCode,
} from "../../services/auth/commands.ts";
import { normalizeEmail } from "../../services/auth/internal.ts";
import { findUserByEmail, listSessions } from "../../services/auth/queries.ts";
import { getUser } from "../../services/user/queries.ts";
import type { SessionId } from "../../types/id.ts";
import { fail } from "../errors.ts";
import { allow } from "../rate-limit.ts";

const emailBody = {
  type: "object",
  required: ["email"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email", maxLength: 320 },
  },
} as const;

const verifyBody = {
  type: "object",
  required: ["email", "code"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email", maxLength: 320 },
    code: { type: "string", pattern: "^[0-9]{6}$" },
  },
} as const;

const sessionParams = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" },
  },
} as const;

const mintCode = () => randomInt(0, 1_000_000).toString().padStart(6, "0");

export function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string } }>(
    "/auth/email/start",
    { schema: { body: emailBody } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const windowMs = config.auth.rateWindowMs();
      if (
        !allow("email", email, config.auth.rateMaxPerEmail(), windowMs) ||
        !allow("email-ip", request.ip, config.auth.rateMaxPerIp(), windowMs)
      ) {
        return fail(reply, 429, "limit_exceeded");
      }
      const review = config.auth.reviewLogin();
      const devCode = config.auth.devLoginCode();
      if (!review && !devCode && !mailConfigured()) {
        return fail(reply, 503, "email_unavailable");
      }
      const userId = await findOrCreateUser(email);
      const code = review?.email === email ? review.code : (devCode ?? mintCode());
      await setLoginCode(userId, code, config.auth.emailLoginTtlMinutes());
      if (review?.email !== email && !devCode) await sendLoginCode(email, code);
      if (devCode && review?.email !== email) {
        request.log.warn({ email }, "dev login code returned without email");
        return { ok: true, code: devCode };
      }
      return { ok: true };
    },
  );

  app.post<{ Body: { email: string; code: string } }>(
    "/auth/email/verify",
    { schema: { body: verifyBody } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const userId = await findUserByEmail(email);
      if (!userId || !(await verifyLoginCode(userId, request.body.code))) {
        return fail(reply, 401, "unauthorized");
      }
      const token = await issueSession(userId);
      const user = await getUser(userId);
      if (!user) return fail(reply, 401, "unauthorized");
      return { token, user };
    },
  );

  app.post("/auth/logout", { preHandler: app.authenticate }, async (request) => {
    const token = request.authenticated?.token;
    if (token) await revokeSessionByToken(token);
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/auth/sessions",
    { schema: { querystring: pageQuerySchema }, preHandler: app.authenticate },
    async (request) => {
      const current = request.authenticated?.session.id;
      const { limit, offset } = pageOf(request.query);
      const found = await listSessions(request.authenticated!.user.id, limit, offset);
      return {
        items: found.items.map((session) => ({
          id: session.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          current: session.id === current,
        })),
        nextOffset: found.nextOffset,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/auth/sessions/:id/revoke",
    { schema: { params: sessionParams }, preHandler: app.authenticate },
    async (request, reply) => {
      const revoked = await revokeSession(
        request.params.id as SessionId,
        request.authenticated!.user.id,
      );
      if (!revoked) return fail(reply, 404, "not_found");
      return { ok: true };
    },
  );
}
