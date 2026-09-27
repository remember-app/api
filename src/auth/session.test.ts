import { afterAll, expect, test } from "vitest";
import { sql } from "../db.ts";
import { sessionTtlDays } from "./config.ts";
import { hashToken } from "./session.ts";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "./testing.ts";

const email = () => testEmail("task416");

afterAll(async () => {
  await cleanupTestUsers("task416");
});

type App = ReturnType<typeof buildTestApp>["app"];

const termHours = () => sessionTtlDays() * 24;

const me = (app: App, token: string) =>
  app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });

/**
 * Time passing, where a test cannot wait a month: the session's end moves that
 * many hours closer to now, and the end is all the session check reads.
 */
const age = (token: string, hours: number) => sql`
  update sessions set expires_at = expires_at - make_interval(hours => ${hours})
  where token_hash = ${hashToken(token)}
`;

const expiresAt = async (token: string) => {
  const [row] = await sql<{ expires_at: Date }[]>`
    select expires_at from sessions where token_hash = ${hashToken(token)}
  `;
  return row?.expires_at;
};

test("a session in use outlives the term it was issued with", async () => {
  const { app } = buildTestApp();
  const { token } = await signIn(app, email());
  const issued = await expiresAt(token);

  // Fresh, it is not rewritten on every request.
  expect((await me(app, token)).statusCode).toBe(200);
  expect(await expiresAt(token)).toEqual(issued);

  // Used a day in, then left alone for nearly a whole term: that is past the
  // end it was issued with, and still no new sign-in.
  await age(token, 24);
  expect((await me(app, token)).statusCode).toBe(200);
  await age(token, termHours() - 2);
  expect((await me(app, token)).statusCode).toBe(200);

  // The term starts over from the use and does not pile up.
  const [row] = await sql<{ fresh: boolean }[]>`
    select expires_at > now() + make_interval(days => ${sessionTtlDays()}) - interval '1 minute'
       and expires_at <= now() + make_interval(days => ${sessionTtlDays()}) as fresh
    from sessions where token_hash = ${hashToken(token)}
  `;
  expect(row?.fresh).toBe(true);

  await app.close();
});

test("a session left untouched for a whole term expires, counted from its last use", async () => {
  const { app } = buildTestApp();

  const never = await signIn(app, email());
  await age(never.token, termHours());
  expect((await me(app, never.token)).statusCode).toBe(401);

  const once = await signIn(app, email());
  await age(once.token, 24);
  expect((await me(app, once.token)).statusCode).toBe(200);
  await age(once.token, termHours());
  const refused = await me(app, once.token);
  expect(refused.statusCode).toBe(401);
  expect(refused.json()).toEqual({ error: "unauthorized" });

  await app.close();
});

test("signing out ends the session at once, and the renewal does not bring it back", async () => {
  const { app } = buildTestApp();
  const { token } = await signIn(app, email());

  // Due for renewal, so the sign-out request itself renews it on the way in.
  await age(token, termHours() - 1);
  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(logout.statusCode).toBe(200);

  expect((await me(app, token)).statusCode).toBe(401);
  expect((await me(app, token)).statusCode).toBe(401);

  await app.close();
});
