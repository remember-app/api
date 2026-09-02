import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { buildApp } from "../app.ts";
import { sql } from "../db.ts";
import type { AuthUser } from "./session.ts";

/**
 * The fixture the auth test files share. Tests run against the real local
 * database, so every address carries the calling file's tag: each one then
 * clears up exactly its own rows and nobody else's.
 */
export const testEmail = (tag: string) => `${tag}-test-${randomUUID()}@example.com`;

/** Undoes `testEmail(tag)`. Sessions, identities and link tokens cascade off. */
export const cleanupTestUsers = (tag: string) =>
  sql`delete from users where email like ${`${tag}-test-%@example.com`}`;

/** An app with its own log: the magic link is delivered nowhere else. */
export function buildTestApp() {
  const lines: string[] = [];
  const app = buildApp({
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
  });
  return { app, lines };
}

/** Takes the token from exactly where a live tester takes it — the log. */
export function linkToken(lines: string[]) {
  const line = lines
    .map((l) => JSON.parse(l) as { msg?: string; link?: string })
    .findLast((l) => l.msg === "magic link issued");
  expect(line?.link).toMatch(/^remember:\/\/auth\/email\?token=/);
  return new URL(line?.link ?? "").searchParams.get("token") ?? "";
}

/**
 * A whole sign-in, for tests that need a live session rather than the route
 * that mints one: start -> link out of the log -> verify.
 */
export async function signIn(
  app: ReturnType<typeof buildTestApp>["app"],
  lines: string[],
  email: string,
): Promise<{ token: string; user: AuthUser }> {
  const start = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email } });
  expect(start.statusCode).toBe(200);
  const verified = await app.inject({
    method: "POST",
    url: "/auth/email/verify",
    payload: { token: linkToken(lines) },
  });
  expect(verified.statusCode).toBe(200);
  return verified.json();
}
