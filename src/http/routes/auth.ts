import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.ts";
import {
  findOrCreateUser,
  findUserByEmail,
  issueSession,
  listSessions,
  normalizeEmail,
  revokeSession,
  revokeSessionByToken,
  setLoginCode,
  verifyLoginCode,
} from "../../domains/auth/auth.ts";
import { getUser } from "../../domains/user/user.ts";
import { mailConfigured, sendLoginCode } from "../../integrations/mail/index.ts";
import type { SessionId } from "../../types/id.ts";
import { fail } from "../errors.ts";

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
      const review = config.auth.reviewLogin();
      if (!review && !mailConfigured()) {
        return fail(reply, 503, "email_unavailable");
      }
      const userId = await findOrCreateUser(email);
      const code = review?.email === email ? review.code : mintCode();
      await setLoginCode(userId, code, config.auth.emailLoginTtlMinutes());
      if (review?.email !== email) await sendLoginCode(email, code);
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

  app.get("/auth/sessions", { preHandler: app.authenticate }, async (request) => {
    const current = request.authenticated?.session.id;
    const sessions = await listSessions(request.authenticated!.user.id);
    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      current: session.id === current,
    }));
  });

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
