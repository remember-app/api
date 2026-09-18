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
 * to the network. The code comes back out of what was posted, because that is
 * the only place it exists: the log no longer carries it.
 */
const letters: { to: string[]; subject: string; text: string }[] = [];
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

type App = ReturnType<typeof buildTestApp>["app"];

const startLogin = (app: App, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/auth/email/start", payload });

const verifyCode = (app: App, email: string, code: string) =>
  app.inject({ method: "POST", url: "/auth/email/verify", payload: { email, code } });

/**
 * The code out of the last letter — where a person takes it from as well.
 * Six digits standing alone, so the minute count in the same sentence («живёт
 * 15 мин») is not mistaken for it.
 */
function letterCode() {
  const code = letters.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
  expect(code).toMatch(/^\d{6}$/);
  return code ?? "";
}

/** Six digits that are not the given ones, for the guesses that must fail. */
const wrongCode = (code: string, step: number) =>
  String((Number(code) + step) % 1_000_000).padStart(6, "0");

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

// The one migration in this milestone that runs against a table it did not
// create: `DROP CONSTRAINT IF EXISTS` before the `ADD CONSTRAINT` exists
// precisely so a process killed between the column and the version mark can
// replay the whole file — proven here rather than trusted, because a plain
// `ADD CONSTRAINT` would 500 on the replay with "constraint already exists".
test("migration 030 applies to an existing users table and is idempotent", async () => {
  const file = await readFile(
    new URL("../../migrations/030.do.language.sql", import.meta.url),
    "utf8",
  );
  const db = await sql.reserve();
  try {
    await db
      .unsafe(`drop schema if exists mig_test_030 cascade;
               create schema mig_test_030;
               set search_path to mig_test_030, public`)
      .simple();
    // The table 030 alters, standing in for the one migration 002 already
    // created by the time 030 runs for real.
    await db.unsafe("create table users (id int primary key)").simple();
    await db.unsafe(file).simple();
    await db.unsafe(file).simple(); // the replay after a killed process

    const [column] = await db<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_schema = 'mig_test_030' and table_name = 'users' and column_name = 'language'
    `;
    expect(column?.is_nullable).toBe("NO");
    expect(column?.column_default).toContain("ru");

    const constraints = await db<{ constraint_name: string }[]>`
      select constraint_name from information_schema.table_constraints
      where table_schema = 'mig_test_030' and table_name = 'users'
        and constraint_type = 'CHECK' and constraint_name = 'users_language_check'
    `;
    // Not just present by name: the replay must leave exactly one live CHECK,
    // not zero (dropped and never re-added) and not a Postgres-numbered
    // duplicate from a naive re-add.
    expect(constraints).toHaveLength(1);

    // And it still holds — proven by trying to break it, not by its name.
    await db.unsafe("insert into users (id) values (1)").simple();
    await expect(
      db.unsafe("insert into users (id, language) values (2, 'fr')").simple(),
    ).rejects.toThrow(/users_language_check/);
    await db.unsafe("insert into users (id, language) values (3, 'en')").simple();
  } finally {
    await db.unsafe("drop schema if exists mig_test_030 cascade; reset search_path").simple();
    db.release();
  }
});

// 060 runs against tables it did not create — it takes the link tokens out and
// puts the codes in — so, like 030, it is proven against the schema it will
// actually meet rather than against an empty one. The replay matters for the
// same reason it does there: a process killed between the file and its version
// mark runs the whole file again, and `DROP … IF EXISTS` before
// `CREATE … IF NOT EXISTS` is what makes that harmless.
test("migration 060 swaps link tokens for codes, replays, and undoes", async () => {
  const read = (name: string) =>
    readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
  const [auth, file, undo] = await Promise.all([
    read("002.do.auth.sql"),
    read("060.do.login-code.sql"),
    read("060.undo.login-code.sql"),
  ]);
  const db = await sql.reserve();
  try {
    await db
      .unsafe(`drop schema if exists mig_test_060 cascade;
               create schema mig_test_060;
               set search_path to mig_test_060, public`)
      .simple();
    // The state 060 finds when it runs for real: 002's tables, link tokens and
    // all. Without them the DROP would be a no-op and prove nothing.
    await db.unsafe(auth).simple();
    await db.unsafe(file).simple();
    await db.unsafe(file).simple(); // the replay after a killed process

    const tables = async () =>
      (
        await db<{ table_name: string }[]>`
          select table_name from information_schema.tables where table_schema = 'mig_test_060'
        `
      )
        .map((t) => t.table_name)
        .sort();
    expect(await tables()).toEqual(["auth_identities", "email_login_codes", "sessions", "users"]);

    // And back: the undo leaves the schema the code of that time writes into,
    // which is the only thing an undo is for.
    await db.unsafe(undo).simple();
    expect(await tables()).toEqual(["auth_identities", "email_login_tokens", "sessions", "users"]);
  } finally {
    await db.unsafe("drop schema if exists mig_test_060 cascade; reset search_path").simple();
    db.release();
  }
});

test("the whole sign-in: start -> code in the letter -> verify -> session -> GET /me", async () => {
  const { app } = buildTestApp();
  const email = testEmail();

  const start = await startLogin(app, { email });
  expect(start.statusCode).toBe(200);
  expect(start.json()).toEqual({ ok: true });

  const code = letterCode();
  // Only the salted scrypt hash is in the table — the digits themselves appear
  // in no column of it, so a dump of this table is not a dump of live sign-ins.
  const [stored] = await sql<{ row: Record<string, unknown> }[]>`
    select to_jsonb(c) as row from email_login_codes c
    where c.user_id = (
      select user_id from auth_identities
      where provider = 'email' and provider_account_id = ${email}
    )
  `;
  expect(stored).toBeDefined();
  expect(JSON.stringify(stored?.row)).not.toContain(code);

  const verified = await verifyCode(app, email, code);
  expect(verified.statusCode).toBe(200);
  const { token, user } = verified.json() as { token: string; user: Record<string, unknown> };
  // A language comes with the account from the first moment: what the server
  // composes for a person is composed without them, so there is no null here.
  expect(user).toEqual({
    id: expect.any(String),
    username: null,
    name: null,
    email,
    language: "ru",
  });

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

test("the letter goes out in the language the request asked for", async () => {
  const { app } = buildTestApp();
  try {
    // No language at all — what every client sent before the field existed, so
    // it must still be the Russian letter.
    expect((await startLogin(app, { email: testEmail() })).statusCode).toBe(200);
    expect(letters.at(-1)?.subject).toBe("Вход в Remember");
    expect(letters.at(-1)?.text).toContain("Код одноразовый");

    expect((await startLogin(app, { email: testEmail(), language: "ru" })).statusCode).toBe(200);
    expect(letters.at(-1)?.subject).toBe("Вход в Remember");

    expect((await startLogin(app, { email: testEmail(), language: "en" })).statusCode).toBe(200);
    expect(letters.at(-1)?.subject).toBe("Your sign-in code for Remember");
    expect(letters.at(-1)?.text).toContain("type it into the app");
    // One language per letter, not a mixture of both.
    expect(letters.at(-1)?.text).not.toMatch(/[А-Яа-я]/);
    // And whichever language it is, the code it exists to carry is in it.
    expect(letters.at(-1)?.text).toMatch(/\b\d{6}\b/);

    // A third language is a bug in the client, and it is told so rather than
    // quietly served the default letter.
    expect((await startLogin(app, { email: testEmail(), language: "de" })).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

/** The env the dev door is decided by, saved and put back around each test. */
const doorEnv = ["RESEND_API_KEY", "MAIL_FROM", "NODE_ENV", "EMAIL_LOGIN_DEV_BYPASS"];
const saveEnv = () => doorEnv.map((name) => process.env[name]);
function restoreEnv(saved: (string | undefined)[]) {
  for (const [i, name] of doorEnv.entries()) setEnv(name, saved[i]);
}

/** An address on the one domain the door looks at, tagged like all the others. */
const doorEmail = () => testEmail().replace("@example.com", "@test.test");

// The lock on the way in that development gets. Pinned by a test and not by a
// promise: if this ever stops being 503, production hands the key to any
// account to whoever types its address.
//
// `not.toMatch(/\d{6}/)` is how «no code came back» is spelled throughout:
// the body that would betray the lock is the one with six digits in it.
test("the lock: in production an unconfigured mailbox is still 503, never a code", async () => {
  const previous = saveEnv();
  setEnv("RESEND_API_KEY", undefined);
  setEnv("MAIL_FROM", undefined);
  // On, deliberately: production is not a place where the switch gets a
  // hearing. Somebody will one day set it on a staging box that is really the
  // production one, and that must change nothing here.
  setEnv("EMAIL_LOGIN_DEV_BYPASS", "1");
  const { app } = buildTestApp();
  try {
    // Spelled the way a person types it once into a hosting panel and never
    // looks at again. A lock that only recognises one of these is not a lock:
    // every spelling it misses hands the link out instead.
    for (const spelling of ["production", "production ", "Production", "prod"]) {
      setEnv("NODE_ENV", spelling);
      // The ordinary address and the one the switch would open outside
      // production: in production neither is let through.
      for (const email of [testEmail(), doorEmail()]) {
        const response = await startLogin(app, { email });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: "mail not configured" });
        expect(response.body).not.toMatch(/\d{6}/);

        // The other half of the promise the handler makes, and the half a
        // status code cannot show: the answer comes before the user is made
        // and before a code is minted. Without this the check could drift
        // below `startEmailLogin` and every request during a mail outage would
        // quietly mint a live login token that simply never gets returned.
        const users = await sql`select 1 from users where email = ${email}`;
        expect(users).toHaveLength(0);
      }
    }
  } finally {
    restoreEnv(previous);
    await app.close();
  }
});

// The realistic disaster, not the tidy one: every real deployment has mail
// keys, so the 503 lock above never even engages there — `mailConfigured()`
// is true and the request runs its ordinary course regardless of `bypass`.
// The only thing standing between a switch flipped on by mistake and a leaked
// session is the production check baked into `bypass` itself. This pins that,
// with real keys in place, a production box still posts the real letter and
// the answer never carries a code — prod prefix included.
test("the lock holds with mail configured too: production still sends the letter, never the code", async () => {
  const previous = saveEnv();
  setEnv("EMAIL_LOGIN_DEV_BYPASS", "1");
  const { app } = buildTestApp();
  const posted = letters.length;
  const sent: string[] = [];
  try {
    for (const spelling of ["production", "prod"]) {
      setEnv("NODE_ENV", spelling);
      const email = doorEmail();
      sent.push(email);
      const response = await startLogin(app, { email });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(response.body).not.toMatch(/\d{6}/);
    }
    // A real letter per request, addressed to the real recipient — the
    // ordinary path taken both times, not the bypass.
    expect(letters.slice(posted).map((letter) => letter.to[0])).toEqual(sent);
  } finally {
    restoreEnv(previous);
    await app.close();
  }
});

// The door development keeps, and the whole of it. It used to be «not
// production», which is a door that opens itself: an unset variable on a
// machine nobody was thinking about handed a session for any address to
// whoever typed it. Now it takes a switch somebody turned on by hand, and even
// then only test.test goes through.
test("the dev door: only test.test, only with the switch on, and never on absence", async () => {
  const previous = saveEnv();
  setEnv("RESEND_API_KEY", undefined);
  setEnv("MAIL_FROM", undefined);
  // The documented local default: .env.example ships with NODE_ENV commented
  // out, so this is the state a developer's machine is actually in.
  setEnv("NODE_ENV", undefined);
  const { app } = buildTestApp();
  const posted = letters.length;
  const refused = async (email: string) => {
    const response = await startLogin(app, { email });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/\d{6}/);
    // Refused all the way: no user, so nothing was half-done on the way out.
    expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0);
  };
  try {
    // Switch absent — no door at all, not for anybody. This is the case the
    // old behaviour got wrong.
    setEnv("EMAIL_LOGIN_DEV_BYPASS", undefined);
    await refused(testEmail());
    await refused(doorEmail());

    // Present but not a yes. This one opens rather than locks, so anything it
    // does not recognise has to leave it shut — `=0` is a person saying no.
    for (const value of ["", "0", "no", "yes please"]) {
      setEnv("EMAIL_LOGIN_DEV_BYPASS", value);
      await refused(doorEmail());
    }

    setEnv("EMAIL_LOGIN_DEV_BYPASS", "1");
    // On, and still no door for an ordinary address: the switch opens one
    // domain, not the route.
    await refused(testEmail());
    // And the domain is the whole tail, not a suffix — otherwise anyone who
    // can register a name could point `test.test` at the end of their own.
    await refused(doorEmail().replace("@test.test", "@evil.test.test"));

    // On, and a test.test address: in, with the code in the answer.
    const email = doorEmail();
    const opened = await startLogin(app, { email });
    expect(opened.statusCode).toBe(200);
    const { ok, code } = opened.json() as { ok: boolean; code: string };
    expect(ok).toBe(true);
    expect(code).toMatch(/^\d{6}$/);
    // Nothing went anywhere: there is no provider to send through.
    expect(letters).toHaveLength(posted);

    // And the code is the real thing, not a decoration: it opens a session,
    // which is the whole point of handing it over.
    const verified = await verifyCode(app, email, code);
    expect(verified.statusCode).toBe(200);
    expect((verified.json() as { token: string }).token).toEqual(expect.any(String));

    // The keys make no difference to the door — it is the switch and the
    // domain that decide. A letter to test.test has nowhere to arrive.
    setEnv("RESEND_API_KEY", "test-key");
    setEnv("MAIL_FROM", "Remember <no-reply@example.com>");
    const withKeys = await startLogin(app, { email: doorEmail() });
    expect(withKeys.statusCode).toBe(200);
    expect((withKeys.json() as { code: string }).code).toMatch(/^\d{6}$/);
    expect(letters).toHaveLength(posted);
  } finally {
    restoreEnv(previous);
    await app.close();
  }
});

test("switching the letter's language does not buy a second rate-limit budget", async () => {
  const previous = process.env.EMAIL_LOGIN_RATE_MAX;
  process.env.EMAIL_LOGIN_RATE_MAX = "2";
  const { app } = buildTestApp();
  try {
    // The limiter's key is the mailbox alone (see auth/plugin.ts); language is
    // not in it, so the same address must spend one shared budget whichever
    // language each call asks for — not a bucket per language.
    const address = testEmail();
    const start = (language?: string) =>
      app.inject({
        method: "POST",
        url: "/auth/email/start",
        payload: { email: address, language },
      });

    expect((await start("ru")).statusCode).toBe(200);
    expect((await start("en")).statusCode).toBe(200);
    const limited = await start("ru");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "too many requests" });
    // Absent counts too — it is the same request as `language: "ru"` in
    // everything the limiter looks at.
    expect((await start(undefined)).statusCode).toBe(429);
  } finally {
    setEnv("EMAIL_LOGIN_RATE_MAX", previous);
    await app.close();
  }
});

test("signing in again with the same address does not make a second user", async () => {
  const { app } = buildTestApp();
  const email = testEmail();

  const ids: string[] = [];
  const starts: string[] = [];
  for (let i = 0; i < 2; i++) {
    const start = await startLogin(app, { email });
    starts.push(`${start.statusCode} ${start.body}`);
    const res = await verifyCode(app, email, letterCode());
    ids.push((res.json() as { user: { id: string } }).user.id);
  }
  expect(ids[0]).toBe(ids[1]);

  // The anti-enumeration contract: the second call knows the address is
  // registered and must still answer exactly what the first one did.
  expect(starts[1]).toBe(starts[0]);
  expect(starts[0]).toBe('200 {"ok":true}');

  await app.close();
});

test("the code is single-use: a second verify with it is 401", async () => {
  const { app } = buildTestApp();
  const email = testEmail();

  await startLogin(app, { email });
  const code = letterCode();

  const first = await verifyCode(app, email, code);
  expect(first.statusCode).toBe(200);

  // Spent in the moment it worked, not merely left to expire.
  const second = await verifyCode(app, email, code);
  expect(second.statusCode).toBe(401);
  expect(second.json()).toEqual({ error: "invalid or expired code" });

  await app.close();
});

// Six digits is one of a million, and a million is a number a script gets
// through in an afternoon. The ceiling on attempts is the whole of what stands
// between that script and every account on the product, so it is pinned here
// rather than trusted — and the half that is easy to get wrong is the last
// line: a code whose attempts are gone has to be dead to the right digits too.
// A ceiling that only refuses wrong guesses refuses nothing at all.
test("the code cannot be guessed: once the attempts are spent, the right code is refused too", async () => {
  const previous = process.env.EMAIL_LOGIN_MAX_ATTEMPTS;
  process.env.EMAIL_LOGIN_MAX_ATTEMPTS = "3";
  const { app } = buildTestApp();
  try {
    const email = testEmail();
    expect((await startLogin(app, { email })).statusCode).toBe(200);
    const code = letterCode();

    // Three guesses, none of them the code — which is how a script arrives.
    for (const step of [1, 2, 3]) {
      const guess = await verifyCode(app, email, wrongCode(code, step));
      expect(guess.statusCode).toBe(401);
      expect(guess.json()).toEqual({ error: "invalid or expired code" });
    }

    // The fourth call carries the real code, and is refused all the same — and
    // refused in exactly the same words, so the guesser cannot even learn that
    // this one was the one.
    const spent = await verifyCode(app, email, code);
    expect(spent.statusCode).toBe(401);
    expect(spent.json()).toEqual({ error: "invalid or expired code" });

    // The account is not locked, the code was: asking again gets a new one and
    // it works. That is the only way past, and it costs a request that the rate
    // limit on /auth/email/start counts.
    expect((await startLogin(app, { email })).statusCode).toBe(200);
    const fresh = await verifyCode(app, email, letterCode());
    expect(fresh.statusCode).toBe(200);
    expect((fresh.json() as { token: string }).token).toEqual(expect.any(String));
  } finally {
    setEnv("EMAIL_LOGIN_MAX_ATTEMPTS", previous);
    await app.close();
  }
});

test("an expired code is refused exactly as a wrong one is, and a stranger's code is nobody's", async () => {
  const { app } = buildTestApp();
  try {
    const email = testEmail();
    await startLogin(app, { email });
    const code = letterCode();

    // Somebody else's live code, right digits and all: the code is the secret
    // of one address, and a million of them in the air at once must not mean a
    // guess that lands on the wrong person still lets the guesser in.
    const stranger = testEmail();
    await startLogin(app, { email: stranger });
    const strangersCode = letterCode();
    const crossed = await verifyCode(app, email, strangersCode);
    expect(crossed.statusCode).toBe(401);
    expect(crossed.json()).toEqual({ error: "invalid or expired code" });

    // Aged out where a test cannot wait fifteen minutes. `expires_at` is the
    // whole of the TTL, so moving it is the same thing as time passing.
    await sql`
      update email_login_codes set expires_at = now()
      where user_id = (
        select user_id from auth_identities
        where provider = 'email' and provider_account_id = ${email}
      )
    `;
    const expired = await verifyCode(app, email, code);
    expect(expired.statusCode).toBe(401);
    // The same answer as a wrong code, to the letter: a different one would
    // say «those were the right digits, only late», which is worth knowing.
    expect(expired.json()).toEqual({ error: "invalid or expired code" });

    // And a body that is not six digits never reaches any of this.
    for (const bad of [{}, { email }, { email, code: "12345" }, { email, code: "abcdef" }]) {
      expect(
        (await app.inject({ method: "POST", url: "/auth/email/verify", payload: bad })).statusCode,
      ).toBe(400);
    }
  } finally {
    await app.close();
  }
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

  const email = testEmail();
  await startLogin(app, { email });
  const verified = await verifyCode(app, email, letterCode());
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
      language: "ru",
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
      language: "ru",
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
