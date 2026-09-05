import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JWTPayload } from "jose";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sql } from "../db.ts";
import { claimsFrom, type Provider, type ProviderClaims, verifier } from "./providers.ts";
import { hashToken, revokeByToken } from "./session.ts";
import { buildTestApp, cleanupTestUsers, testEmail as sharedTestEmail } from "./testing.ts";

// Every address this file makes is recognisable, so it can clear up after
// itself in the shared dev database.
const testEmail = () => sharedTestEmail("task05");

// A social sign-in leaves a user who may carry no address at all, so those are
// recognised by the provider account id instead.
const testSub = () => `task07-${randomUUID()}`;

/**
 * Resend, stood in for. `/auth/email/start` really posts the letter now, so
 * these tests give it somewhere to post to — a host of their own, aimed at
 * through `RESEND_API_URL`, so that nothing here needs mail keys or a way out
 * to the network. The link comes back out of what was posted, because that is
 * the only place it exists: the log no longer carries it.
 */
const letters: { to: string[]; text: string }[] = [];
const mailServer = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    letters.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "application/json" }).end('{"id":"stub"}');
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mailServer.listen(0, "127.0.0.1", resolve);
  });
  process.env.RESEND_API_URL = `http://127.0.0.1:${(mailServer.address() as AddressInfo).port}`;
  process.env.RESEND_API_KEY = "test-key";
  process.env.MAIL_FROM = "Remember <no-reply@example.com>";
});

/** The token out of the last letter — where a person takes it from as well. */
function linkToken() {
  const link = letters.at(-1)?.text.match(/remember:\/\/\S+/)?.[0];
  expect(link).toMatch(/^remember:\/\/auth\/email\?token=/);
  return new URL(link ?? "").searchParams.get("token") ?? "";
}

afterAll(async () => {
  mailServer.close();
  await cleanupTestUsers("task05");
  await sql`
    delete from users
    where id in (select user_id from auth_identities where provider_account_id like 'task07-%')
  `;
  await sql.end();
});

/** Assigning `undefined` to process.env would store the string "undefined". */
function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

test("the whole magic link: start -> link in the letter -> verify -> session -> GET /me", async () => {
  const { app } = buildTestApp();
  const email = testEmail();

  const start = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email } });
  expect(start.statusCode).toBe(200);
  expect(start.json()).toEqual({ ok: true });

  const verified = await app.inject({
    method: "POST",
    url: "/auth/email/verify",
    payload: { token: linkToken() },
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
  const { app } = buildTestApp();
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
      payload: { token: linkToken() },
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
  const { app } = buildTestApp();

  await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: testEmail() } });
  const token = linkToken();

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
  const { app } = buildTestApp();

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
    payload: { token: linkToken() },
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

// Gmail ignores dots in the local part and serves googlemail.com from the same
// inbox, so `a.b@`, `ab@` and `a.b@googlemail.com` are one mailbox. Without the
// fold each spelling carried its own budget, and since the letter became real
// that is a way to put four times the mail into somebody else's inbox.
test("gmail's dots and googlemail.com are one mailbox for the limiter", async () => {
  const previous = process.env.EMAIL_LOGIN_RATE_MAX;
  process.env.EMAIL_LOGIN_RATE_MAX = "2";
  const { app } = buildTestApp();
  const local = `task05-dots-${randomUUID()}`;
  try {
    const start = (email: string) =>
      app.inject({ method: "POST", url: "/auth/email/start", payload: { email } });

    expect((await start(`${local}@gmail.com`)).statusCode).toBe(200);
    // Dotted, and the dots are not part of the address Gmail delivers to.
    expect((await start(`${local.slice(0, 4)}.${local.slice(4)}@gmail.com`)).statusCode).toBe(200);
    // The third spelling finds the budget already spent — which is the point.
    expect((await start(`${local}@googlemail.com`)).statusCode).toBe(429);
    expect((await start(`${local}+tag@gmail.com`)).statusCode).toBe(429);

    // A dot elsewhere is still significant: two people, two budgets.
    expect((await start(`${local}@example.com`)).statusCode).toBe(200);
    expect((await start(`${local.slice(0, 4)}.${local.slice(4)}@example.com`)).statusCode).toBe(
      200,
    );
  } finally {
    setEnv("EMAIL_LOGIN_RATE_MAX", previous);
    await sql`delete from users where email like ${"task05-dots-%"}`;
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

/**
 * Stands in for the JWKS check. Apple's and Google's signatures cannot be
 * produced without their private keys, so the one thing these tests cannot
 * exercise is the verification itself — everything before it and everything
 * after it is the production path, and the stub is put back afterwards.
 */
function stubVerify(fake: typeof verifier.verify) {
  const real = verifier.verify;
  verifier.verify = fake;
  return () => {
    verifier.verify = real;
  };
}

const claims = (over: Partial<ProviderClaims> = {}): ProviderClaims => ({
  sub: testSub(),
  name: "Тест Тестов",
  email: testEmail(),
  ...over,
});

test("the claims are taken from a payload by type, not on trust", () => {
  const full = { sub: "001122.abc", name: "Иван", email: "ivan@privaterelay.appleid.com" };
  expect(claimsFrom(full)).toEqual(full);
  // What Apple sends on every sign-in after the first.
  expect(claimsFrom({ sub: "001122.abc" })).toEqual({ sub: "001122.abc", name: null, email: null });

  // A payload is parsed JSON: jose checks only the claims it is asked to
  // (`iss`, `aud`, `exp`), so the types declared for the rest are a promise
  // nobody keeps. `sub` is the binding and must be a real string or nothing.
  for (const bad of [{}, { sub: "" }, { sub: 123 }, { sub: null }, { sub: ["a"] }]) {
    expect(() => claimsFrom(bad as JWTPayload)).toThrow(/sub/);
  }
  // Anything else that is not a string is dropped rather than stored: an object
  // in `name` would otherwise reach a text column and come back a 500.
  const odd = { sub: "x", name: { given: "И" }, email: 42 } as unknown as JWTPayload;
  expect(claimsFrom(odd)).toEqual({ sub: "x", name: null, email: null });
});

const signInWith = (
  app: ReturnType<typeof buildTestApp>["app"],
  provider: Provider,
  idToken = "id-token",
) => app.inject({ method: "POST", url: `/auth/${provider}`, payload: { idToken } });

test("a provider with no client id is off: 501, no verification, and the app still builds", async () => {
  const previous = [process.env.APPLE_CLIENT_ID, process.env.GOOGLE_CLIENT_ID];
  setEnv("APPLE_CLIENT_ID", undefined);
  // A blank value is the same misconfiguration as an absent one: taken as an
  // audience it would switch the `aud` check off rather than the provider.
  setEnv("GOOGLE_CLIENT_ID", "   ");
  let verifications = 0;
  const restore = stubVerify(async () => {
    verifications++;
    return claims();
  });
  const { app } = buildTestApp();
  try {
    for (const provider of ["apple", "google"] as const) {
      const res = await signInWith(app, provider);
      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual({ error: "provider not configured" });
    }
    // The token was never looked at — an unconfigured provider is refused
    // before anything is trusted, not after.
    expect(verifications).toBe(0);

    // And the same guard again inside the verifier, which is the one that
    // matters: jose skips the audience check entirely when `audience` is
    // undefined, so an unset client id must fail loudly rather than accept a
    // token minted for another app.
    restore();
    await expect(verifier.verify("apple", "whatever")).rejects.toThrow(/client id/);
  } finally {
    restore();
    setEnv("APPLE_CLIENT_ID", previous[0]);
    setEnv("GOOGLE_CLIENT_ID", previous[1]);
    await app.close();
  }
});

test("a verified id token makes the user, the identity and a session", async () => {
  const previous = process.env.GOOGLE_CLIENT_ID;
  setEnv("GOOGLE_CLIENT_ID", "test.apps.googleusercontent.com");
  const given = claims();
  const seen: [string, string][] = [];
  const restore = stubVerify(async (provider, idToken) => {
    seen.push([provider, idToken]);
    return given;
  });
  const { app } = buildTestApp();
  try {
    const res = await signInWith(app, "google", "the-id-token");
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json() as { token: string; user: Record<string, unknown> };

    // Exactly the shape /auth/email/verify answers with — one contract for the
    // app whichever provider it signed in through.
    expect(user).toEqual({
      id: expect.any(String),
      username: null,
      name: given.name,
      email: given.email,
    });
    expect(seen).toEqual([["google", "the-id-token"]]);

    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(user);

    // Bound by the provider's stable id, and nothing else was written.
    const identities = await sql`
      select provider, provider_account_id from auth_identities where user_id = ${String(user.id)}
    `;
    expect(identities).toEqual([{ provider: "google", provider_account_id: given.sub }]);
  } finally {
    restore();
    setEnv("GOOGLE_CLIENT_ID", previous);
    await app.close();
  }
});

test("the same provider account is the same user, and a token that carries no profile is fine", async () => {
  const previous = process.env.APPLE_CLIENT_ID;
  setEnv("APPLE_CLIENT_ID", "com.remember.app");
  // What Apple actually sends on every sign-in after the first: a sub, and
  // neither name nor address.
  const given = claims({ name: null, email: null });
  const restore = stubVerify(async () => given);
  const { app } = buildTestApp();
  try {
    const first = await signInWith(app, "apple");
    const second = await signInWith(app, "apple");
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);

    const one = first.json() as { token: string; user: { id: string } };
    const two = second.json() as { token: string; user: { id: string } };
    expect(two.user.id).toBe(one.user.id);
    expect(two.token).not.toBe(one.token); // a session per sign-in, both live
    expect((second.json() as { user: unknown }).user).toEqual({
      id: one.user.id,
      username: null,
      name: null,
      email: null,
    });

    const identities = await sql`
      select count(*)::int as n from auth_identities where provider_account_id = ${given.sub}
    `;
    expect(identities).toEqual([{ n: 1 }]);

    for (const token of [one.token, two.token]) {
      const me = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
    }
  } finally {
    restore();
    setEnv("APPLE_CLIENT_ID", previous);
    await app.close();
  }
});

test("two sign-ins landing at once on a new account still make one user", async () => {
  const previous = process.env.APPLE_CLIENT_ID;
  setEnv("APPLE_CLIENT_ID", "com.remember.app");
  const given = claims();
  const restore = stubVerify(async () => given);
  const { app } = buildTestApp();
  try {
    // A double-tap on the sign-in button, or the app retrying a request whose
    // answer it never saw. Both find no account and both go to create one; only
    // the lock in the transaction keeps that from being two users, or a primary
    // key violation answered as a 500.
    const both = await Promise.all([signInWith(app, "apple"), signInWith(app, "apple")]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    const ids = both.map((r) => (r.json() as { user: { id: string } }).user.id);
    expect(ids[0]).toBe(ids[1]);

    const [row] = (await sql`
      select count(*)::int as n from auth_identities where provider_account_id = ${given.sub}
    `) as [{ n: number }];
    expect(row.n).toBe(1);
  } finally {
    restore();
    setEnv("APPLE_CLIENT_ID", previous);
    await app.close();
  }
});

test("two provider accounts sharing an address are two people — accounts never merge on email", async () => {
  const previous = [process.env.APPLE_CLIENT_ID, process.env.GOOGLE_CLIENT_ID];
  setEnv("APPLE_CLIENT_ID", "com.remember.app");
  setEnv("GOOGLE_CLIENT_ID", "test.apps.googleusercontent.com");
  // One address, three distinct provider accounts: the same person at both
  // providers, and a second Apple account that merely reached the same relay
  // address — which Apple can hand out again to somebody else.
  const email = testEmail();
  const restore = stubVerify(async () => claims({ email })); // a fresh sub each time
  const { app } = buildTestApp();
  try {
    const ids: string[] = [];
    for (const provider of ["apple", "google", "apple"] as const) {
      const res = await signInWith(app, provider);
      expect(res.statusCode).toBe(200);
      ids.push((res.json() as { user: { id: string } }).user.id);
    }
    expect(new Set(ids).size).toBe(3);
  } finally {
    restore();
    setEnv("APPLE_CLIENT_ID", previous[0]);
    setEnv("GOOGLE_CLIENT_ID", previous[1]);
    await app.close();
  }
});

test("an id token that does not verify is 401 and leaves nothing behind", async () => {
  const previous = process.env.GOOGLE_CLIENT_ID;
  setEnv("GOOGLE_CLIENT_ID", "test.apps.googleusercontent.com");
  const { app } = buildTestApp();
  // This file's own rows only: the other test files run in parallel against
  // the same database, so a count of everything is a race.
  const rows = async () =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from auth_identities where provider_account_id like 'task07-%'
      `
    )[0]?.n;
  // Refusing the way jose refuses. In place for the whole test, so that a body
  // which slips past validation still cannot reach the network.
  let reason = "";
  const restore = stubVerify(async () => {
    throw new Error(reason);
  });
  try {
    const before = await rows();
    // Every way a token can fail arrives here as a throw — wrong audience,
    // wrong issuer, expired, bad signature, not a JWT at all — and they must be
    // one answer, or the difference tells a forger what to fix.
    for (reason of [
      'unexpected "aud" claim value',
      'unexpected "iss" claim value',
      '"exp" claim timestamp check failed',
      "signature verification failed",
      "Invalid Compact JWS",
    ]) {
      const res = await signInWith(app, "google");
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "invalid token" });
      // Nothing of the reason reaches the caller.
      expect(res.body).not.toContain("aud");
      expect(res.body).not.toContain("signature");
    }

    // A refused token writes nothing: no user, no binding, no session.
    expect(await rows()).toBe(before);

    // A body without a usable token never gets as far as verifying.
    for (const payload of [{}, { idToken: "" }, { token: "wrong-field" }]) {
      const res = await app.inject({ method: "POST", url: "/auth/google", payload });
      expect(res.statusCode).toBe(400);
    }
    // A number is the exception, and harmlessly so: Fastify's ajv coerces it to
    // a string before the handler sees it, so it lands as a bad token rather
    // than a bad body.
    const coerced = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: 42 },
    });
    expect(coerced.statusCode).toBe(401);
  } finally {
    restore();
    setEnv("GOOGLE_CLIENT_ID", previous);
    await app.close();
  }
});
