import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { buildApp } from "../app.ts";
import { sql } from "../db.ts";
import { hashToken, revokeByToken } from "./session.ts";

// Every address this file makes is recognisable, so it can clear up after
// itself in the shared dev database.
const testEmail = () => `task05-test-${randomUUID()}@example.com`;

afterAll(async () => {
  await sql`delete from users where email like 'task05-test-%@example.com'`;
  await sql.end();
});

/** An app with its own log: the magic link is delivered nowhere else. */
function buildTestApp() {
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

/** Assigning `undefined` to process.env would store the string "undefined". */
function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Takes the token from exactly where a live tester takes it — the log. */
function linkToken(lines: string[]) {
  const line = lines
    .map((l) => JSON.parse(l) as { msg?: string; link?: string })
    .findLast((l) => l.msg === "magic link issued");
  expect(line?.link).toMatch(/^remember:\/\/auth\/email\?token=/);
  return new URL(line?.link ?? "").searchParams.get("token") ?? "";
}

test("migration 002 applies to a clean schema and is idempotent", async () => {
  const file = await readFile(new URL("../../migrations/002.do.auth.sql", import.meta.url), "utf8");
  // Its own schema on one reserved connection: a genuine clean database that
  // leaves dev data and any parallel test file untouched.
  const db = await sql.reserve();
  try {
    // Dropped first too: a run killed before the finally would otherwise leave
    // the schema behind and fail every later run on `create schema`.
    await db
      .unsafe(`drop schema if exists mig_test_002 cascade;
               create schema mig_test_002;
               set search_path to mig_test_002, public`)
      .simple();
    await db.unsafe(file).simple();
    await db.unsafe(file).simple(); // the replay after a killed process

    const tables = await db<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'mig_test_002'
    `;
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      "auth_identities",
      "email_login_tokens",
      "sessions",
      "users",
    ]);
  } finally {
    // postgres.js resets nothing on release, so the search_path has to come off
    // by hand or the connection carries it back into the shared pool.
    await db.unsafe("drop schema if exists mig_test_002 cascade; reset search_path").simple();
    db.release();
  }
});

test("the whole magic link: start -> link in the log -> verify -> session -> GET /me", async () => {
  const { app, lines } = buildTestApp();
  const email = testEmail();

  const start = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email } });
  expect(start.statusCode).toBe(200);
  expect(start.json()).toEqual({ ok: true });

  const verified = await app.inject({
    method: "POST",
    url: "/auth/email/verify",
    payload: { token: linkToken(lines) },
  });
  expect(verified.statusCode).toBe(200);
  const { token, user } = verified.json() as { token: string; user: Record<string, unknown> };
  expect(user).toEqual({ id: expect.any(String), username: null, name: null, email });

  const me = await app.inject({
    method: "GET",
    url: "/me",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toEqual(user);

  // Signing in left exactly one 'email' binding, keyed by the lowercased address.
  const identities = await sql`
    select provider, provider_account_id from auth_identities where user_id = ${String(user.id)}
  `;
  expect(identities).toEqual([{ provider: "email", provider_account_id: email }]);

  // Only the SHA-256 hash is stored: the row is found by that hash, and the raw
  // token appears in no column of it.
  const [session] = await sql<{ row: Record<string, unknown> }[]>`
    select to_jsonb(s) as row from sessions s where token_hash = ${hashToken(token)}
  `;
  expect(session).toBeDefined();
  expect(JSON.stringify(session?.row)).not.toContain(token);

  await app.close();
});

test("signing in again with the same address does not make a second user", async () => {
  const { app, lines } = buildTestApp();
  const email = testEmail();

  const ids: string[] = [];
  const starts: string[] = [];
  for (let i = 0; i < 2; i++) {
    const start = await app.inject({
      method: "POST",
      url: "/auth/email/start",
      payload: { email },
    });
    starts.push(`${start.statusCode} ${start.body}`);
    const res = await app.inject({
      method: "POST",
      url: "/auth/email/verify",
      payload: { token: linkToken(lines) },
    });
    ids.push((res.json() as { user: { id: string } }).user.id);
  }
  expect(ids[0]).toBe(ids[1]);

  // The anti-enumeration contract: the second call knows the address is
  // registered and must still answer exactly what the first one did.
  expect(starts[1]).toBe(starts[0]);
  expect(starts[0]).toBe('200 {"ok":true}');

  await app.close();
});

test("the link token is single-use: a second verify with it is 401", async () => {
  const { app, lines } = buildTestApp();

  await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: testEmail() } });
  const token = linkToken(lines);

  const first = await app.inject({ method: "POST", url: "/auth/email/verify", payload: { token } });
  expect(first.statusCode).toBe(200);

  const second = await app.inject({
    method: "POST",
    url: "/auth/email/verify",
    payload: { token },
  });
  expect(second.statusCode).toBe(401);
  expect(second.json()).toEqual({ error: "invalid or expired token" });

  await app.close();
});

test("app.authenticate: 401 for missing, malformed, expired and revoked", async () => {
  const { app, lines } = buildTestApp();

  // Mounted exactly the way the next feature mounts it, and counting its own
  // calls: a 401 must never reach the handler, not merely overwrite its answer.
  let handlerCalls = 0;
  app.get("/probe", { preHandler: app.authenticate }, async (request) => {
    handlerCalls++;
    return { seenUserId: request.user.id };
  });

  await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: testEmail() } });
  const verified = await app.inject({
    method: "POST",
    url: "/auth/email/verify",
    payload: { token: linkToken(lines) },
  });
  const { token } = verified.json() as { token: string };

  const me = (authorization?: string) =>
    app.inject({ method: "GET", url: "/me", headers: authorization ? { authorization } : {} });

  expect((await me()).statusCode).toBe(401);
  expect((await me("")).statusCode).toBe(401);
  expect((await me(token)).statusCode).toBe(401); // no Bearer scheme
  expect((await me("Basic zzz")).statusCode).toBe(401);
  expect((await me("Bearer")).statusCode).toBe(401);
  expect((await me("Bearer nonsense")).statusCode).toBe(401);
  expect((await me(`Bearer ${token}`)).statusCode).toBe(200);
  expect((await me(`bearer ${token}`)).statusCode).toBe(200); // the scheme is case-insensitive
  expect((await me()).json()).toEqual({ error: "unauthorized" });

  await sql`update sessions set expires_at = now() where token_hash = ${hashToken(token)}`;
  expect((await me(`Bearer ${token}`)).statusCode).toBe(401);

  await sql`
    update sessions set expires_at = now() + interval '1 day'
    where token_hash = ${hashToken(token)}
  `;
  expect((await me(`Bearer ${token}`)).statusCode).toBe(200);

  await revokeByToken(token);
  expect((await me(`Bearer ${token}`)).statusCode).toBe(401);

  // Same matrix against a route the next feature would write. The handler runs
  // for the live token and for nothing else.
  const probe = (authorization?: string) =>
    app.inject({ method: "GET", url: "/probe", headers: authorization ? { authorization } : {} });

  await sql`
    update sessions set revoked_at = null, expires_at = now() + interval '1 day'
    where token_hash = ${hashToken(token)}
  `;
  const ok = await probe(`Bearer ${token}`);
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({ seenUserId: expect.any(String) });
  expect(handlerCalls).toBe(1);

  for (const header of [undefined, "", "Bearer", "Basic zzz", "Bearer nonsense"]) {
    expect((await probe(header)).statusCode).toBe(401);
  }
  expect(handlerCalls).toBe(1);

  await app.close();
});

test("/auth/email/start is rate-limited per address, and `+tag` does not dodge it", async () => {
  const previous = process.env.EMAIL_LOGIN_RATE_MAX;
  process.env.EMAIL_LOGIN_RATE_MAX = "2";
  const { app } = buildTestApp();
  try {
    const start = (email: string) =>
      app.inject({ method: "POST", url: "/auth/email/start", payload: { email } });

    const [local, domain] = testEmail().split("@");
    expect((await start(`${local}@${domain}`)).statusCode).toBe(200);
    // Same mailbox behind a subaddress: it must spend the same budget.
    expect((await start(`${local}+one@${domain}`)).statusCode).toBe(200);
    const limited = await start(`${local}+two@${domain}`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "too many requests" });

    // A different address is unaffected — the ceiling is per mailbox, and the
    // far looser per-IP one has not been reached.
    expect((await start(testEmail())).statusCode).toBe(200);
  } finally {
    setEnv("EMAIL_LOGIN_RATE_MAX", previous);
    await app.close();
  }
});

test("/auth/email/start is also rate-limited per IP, across distinct addresses", async () => {
  const previous = process.env.EMAIL_LOGIN_RATE_MAX_PER_IP;
  // Well under the per-mailbox ceiling, so it is the IP bucket that trips.
  process.env.EMAIL_LOGIN_RATE_MAX_PER_IP = "2";
  const { app } = buildTestApp();
  try {
    // A fresh mailbox every call: the per-address budget stays at 1, so only
    // the shared per-IP ceiling can turn a request away.
    const start = () =>
      app.inject({ method: "POST", url: "/auth/email/start", payload: { email: testEmail() } });

    expect((await start()).statusCode).toBe(200);
    expect((await start()).statusCode).toBe(200);
    const limited = await start();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "too many requests" });
  } finally {
    setEnv("EMAIL_LOGIN_RATE_MAX_PER_IP", previous);
    await app.close();
  }
});

test("a broken rate-limit setting falls back to the default instead of switching it off", async () => {
  const previous = process.env.EMAIL_LOGIN_RATE_WINDOW_MINUTES;
  const previousMax = process.env.EMAIL_LOGIN_RATE_MAX;
  // A negative window used to clear the counters on every request, which left
  // the only unauthenticated write route with no limiter at all.
  process.env.EMAIL_LOGIN_RATE_WINDOW_MINUTES = "-15";
  process.env.EMAIL_LOGIN_RATE_MAX = "2";
  const { app } = buildTestApp();
  try {
    const email = testEmail();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/email/start",
        payload: { email },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
  } finally {
    setEnv("EMAIL_LOGIN_RATE_WINDOW_MINUTES", previous);
    setEnv("EMAIL_LOGIN_RATE_MAX", previousMax);
    await app.close();
  }
});

test("a malformed body is refused, and a server fault leaks nothing", async () => {
  const { app } = buildTestApp();

  // Routes have to be in place before the first inject starts the instance.
  app.get("/boom", async () => {
    throw Object.assign(new Error('relation "sessions" does not exist'), { code: "42P01" });
  });

  expect(
    (
      await app.inject({
        method: "POST",
        url: "/auth/email/start",
        payload: { email: "not-an-email" },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/auth/email/start",
        payload: { emial: "typo@example.com" },
      })
    ).statusCode,
  ).toBe(400);

  // Anything that throws must not carry the database's SQLSTATE or the text of
  // the failing statement out to the caller.
  const boom = await app.inject({ method: "GET", url: "/boom" });
  expect(boom.statusCode).toBe(500);
  expect(boom.json()).toEqual({ error: "internal" });
  expect(boom.body).not.toContain("42P01");
  expect(boom.body).not.toContain("sessions");

  await app.close();
});
