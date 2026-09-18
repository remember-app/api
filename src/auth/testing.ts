import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { buildApp } from "../app.ts";
import { sql } from "../db.ts";
import { startEmailLogin } from "./email.ts";
import type { AuthUser } from "./session.ts";

/**
 * The fixture the auth test files share. Tests run against the real local
 * database, so every address carries the calling file's tag: each one then
 * clears up exactly its own rows and nobody else's.
 */
export const testEmail = (tag: string) => `${tag}-test-${randomUUID()}@example.com`;

/**
 * Undoes `testEmail(tag)`. Sessions, identities and login codes cascade off.
 * Keyed on the tag alone and not on the domain: auth.test.ts also makes
 * addresses on test.test — the one domain the dev bypass opens — and those are
 * this tag's rows too.
 */
export const cleanupTestUsers = (tag: string) =>
  sql`delete from users where email like ${`${tag}-test-%`}`;

/** An app with its own log, for the tests that read what it wrote. */
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

/**
 * A whole sign-in, for tests that need a live session rather than the route
 * that mints one: code minted straight from `startEmailLogin` -> verify.
 *
 * It does **not** go through `/auth/email/start`, and that is the point: that
 * route now really posts the code to a mail provider, so every test file in
 * the package that merely wants somebody signed in would otherwise need mail
 * keys and a way out to the network. That route is exercised in `auth.test.ts`,
 * which stands a host of its own in for the provider.
 *
 * The address goes to `startEmailLogin` as it goes to the route — the fixture
 * only ever makes lowercase ones, and the route folds the case itself.
 */
export async function signIn(
  app: ReturnType<typeof buildTestApp>["app"],
  email: string,
): Promise<{ token: string; user: AuthUser }> {
  const code = await startEmailLogin(email);
  const verified = await app.inject({
    method: "POST",
    url: "/auth/email/verify",
    payload: { email, code },
  });
  expect(verified.statusCode).toBe(200);
  return verified.json();
}
