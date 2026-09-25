import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { sql } from "../db.ts";
import { hashToken } from "./session.ts";
import { acceptConsent, buildTestApp, cleanupTestUsers, signIn, testEmail } from "./testing.ts";

const email = () => testEmail("task06");

/**
 * A username no one else can be holding, and legal under the format rule:
 * a leading letter, 12 hex digits, a trailing `i`. Uppercasing it changes the
 * letters among those digits, which is the case collision worth testing; the
 * `i` on the end gives the homoglyph test a character with a non-ASCII
 * counterpart (`İ`) that the database folds onto it.
 */
const username = () => `u${randomUUID().replaceAll("-", "").slice(0, 12)}i`;

afterAll(async () => {
  await cleanupTestUsers("task06");
  await sql.end();
});

type App = ReturnType<typeof buildTestApp>["app"];

/** Every route here is behind the session check, so every call carries a token. */
const as = (token: string, options: InjectOptions) => ({
  ...options,
  headers: { authorization: `Bearer ${token}` },
});

/**
 * Somebody signed in who has accepted the agreement — that is, somebody who
 * may take a username at all. Every test below that claims one starts here,
 * because the first claim *is* registering and registering is gated; the tests
 * that only look things up stay on a bare `signIn`.
 */
async function registered(app: App, address = email()) {
  const session = await signIn(app, address);
  expect((await acceptConsent(app, session.token)).statusCode).toBe(200);
  return session;
}

const setUsername = (app: App, token: string, name: string) =>
  app.inject(as(token, { method: "POST", url: "/me/username", payload: { username: name } }));

const setLanguage = (app: App, token: string, language: unknown) =>
  app.inject(as(token, { method: "POST", url: "/me/language", payload: { language } }));

const setDatesBetweenDays = (app: App, token: string, value: unknown) =>
  app.inject(
    as(token, {
      method: "POST",
      url: "/me/dates-between-days",
      payload: { dates_between_days: value },
    }),
  );

const lookup = (app: App, token: string, name: string) =>
  app.inject(as(token, { method: "GET", url: `/users?username=${encodeURIComponent(name)}` }));

const isFree = (app: App, token: string, name: string) =>
  app.inject(
    as(token, {
      method: "GET",
      url: `/me/username/available?username=${encodeURIComponent(name)}`,
    }),
  );

const sessions = (app: App, token: string) =>
  app.inject(as(token, { method: "GET", url: "/auth/sessions" }));

const me = (app: App, token: string) => app.inject(as(token, { method: "GET", url: "/me" }));

test("no username until the agreement is accepted — that is what registering is", async () => {
  const { app } = buildTestApp();
  const a = await signIn(app, email());
  const b = await signIn(app, email());
  const name = username();

  // Signed in, and that is all: the account exists, the person is not
  // registered, and the nick is what would make them so.
  const refused = await setUsername(app, a.token, name);
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).toEqual({ error: "consent required" });
  // The refusal left nothing behind — not on the row, and not on the nick,
  // which is still there for whoever accepts first.
  expect((await me(app, a.token)).json()).toEqual(a.user);
  expect((await isFree(app, b.token, name)).json()).toEqual({ available: true });

  expect((await acceptConsent(app, a.token)).statusCode).toBe(200);
  const claimed = await setUsername(app, a.token, name);
  expect(claimed.statusCode).toBe(200);
  expect(claimed.json()).toEqual({ ...a.user, username: name });

  // And it is one person's own doing: A accepting says nothing about B, who
  // is still held at the same door.
  expect((await setUsername(app, b.token, username())).statusCode).toBe(403);

  await app.close();
});

test("accepting is idempotent: twice is not an error, and the moment kept is the first", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());

  const first = await acceptConsent(app, token);
  expect(first.statusCode).toBe(200);
  const { accepted_at } = first.json() as { accepted_at: string };
  // A real timestamp, and a recent one — a mark nobody can read a date out of
  // would not be worth the column.
  expect(Date.now() - Date.parse(accepted_at)).toBeLessThan(60_000);

  // The app resends on a lost answer, and somebody who signed in again before
  // picking a nick sees the screen a second time. Neither is an error, and
  // neither moves the mark: the moment worth keeping is when they agreed.
  const again = await acceptConsent(app, token);
  expect(again.statusCode).toBe(200);
  expect(again.json()).toEqual(first.json());

  // Straight off the row, because it is the row the product leans on later.
  const [row] = await sql<{ consent_accepted_at: Date }[]>`
    select consent_accepted_at from users where id = ${user.id}
  `;
  expect(row?.consent_accepted_at?.toISOString()).toBe(new Date(accepted_at).toISOString());

  await app.close();
});

test("changing a nick one already holds never asks for the agreement again", async () => {
  const { app } = buildTestApp();
  const a = await registered(app);
  expect((await setUsername(app, a.token, username())).statusCode).toBe(200);

  // Wiping the mark is not something the API can do — there is no withdrawal —
  // so the row is cut by hand. It is the only way to prove the claim below
  // says something: the change goes through *without* an acceptance to lean
  // on, which is exactly what «only registering is gated» means.
  await sql`update users set consent_accepted_at = null where id = ${a.user.id}`;

  const renamed = await setUsername(app, a.token, username());
  expect(renamed.statusCode).toBe(200);

  await app.close();
});

test("a username is held case-insensitively: FOO blocks foo", async () => {
  const { app } = buildTestApp();
  const a = await registered(app);
  const b = await registered(app);
  const name = username();

  const claimed = await setUsername(app, a.token, name.toUpperCase());
  expect(claimed.statusCode).toBe(200);
  // Exactly the body of GET /me, so the client can drop it straight in.
  expect(claimed.json()).toEqual({ ...a.user, username: name.toUpperCase() });
  expect((await me(app, a.token)).json()).toEqual(claimed.json());

  const collided = await setUsername(app, b.token, name);
  expect(collided.statusCode).toBe(409);
  expect(collided.json()).toEqual({ error: "username taken" });
  // The refusal changed nothing: b is still without a username.
  expect((await me(app, b.token)).json()).toEqual(b.user);

  // The holder may still restyle their own case — it is the same row, so the
  // unique index has nothing to object to.
  expect((await setUsername(app, a.token, name)).statusCode).toBe(200);

  await app.close();
});

test("a freed username is free at once, and the id behind it is stable", async () => {
  const { app } = buildTestApp();
  const a = await registered(app);
  const b = await registered(app);
  const [first, second] = [username(), username()];

  expect((await setUsername(app, a.token, first)).statusCode).toBe(200);
  // A changes away from it. No history is kept, so B may have it immediately.
  expect((await setUsername(app, a.token, second)).statusCode).toBe(200);
  expect((await setUsername(app, b.token, first)).statusCode).toBe(200);

  // And the nick now points at B, while A is reachable under the new one —
  // the id is what stayed put on both sides.
  expect((await lookup(app, a.token, first)).json()).toEqual({
    id: b.user.id,
    username: first,
    name: null,
  });
  expect((await lookup(app, b.token, second)).json()).toMatchObject({ id: a.user.id });

  await app.close();
});

test("the username format is enforced before the database sees it", async () => {
  const { app } = buildTestApp();
  const { token } = await registered(app);
  const name = username();

  const bad = [
    "", // empty
    "ab", // under 3
    `a${"b".repeat(30)}`, // over 30
    "_foo", // separator at the front
    "-foo",
    ".foo",
    "foo_", // separator at the back
    "foo-",
    "foo.",
    "fo o", // space
    "foo!", // punctuation outside the set
    "foo@bar",
    "приве", // non-ASCII: `а` is not `a`, and citext will not tell them apart
    "foo\nbar",
    "foobar\n", // a trailing newline must not slip past the closing anchor
  ];
  for (const candidate of bad) {
    const res = await setUsername(app, token, candidate);
    expect([candidate, res.statusCode]).toEqual([candidate, 400]);
  }
  // And a body without the field at all.
  expect((await app.inject(as(token, { method: "POST", url: "/me/username" }))).statusCode).toBe(
    400,
  );

  // The edges that must pass: 3 long, 30 long, every separator in the middle.
  const good = [name.slice(0, 3), `${name}${"x".repeat(30 - name.length)}`, `${name}_a.b-c`];
  for (const candidate of good) {
    const res = await setUsername(app, token, candidate);
    // Only the gate is under test here — a short name may well be taken
    // already in a shared database, and 409 is not this test's business.
    expect([candidate, res.statusCode]).not.toEqual([candidate, 400]);
  }

  await app.close();
});

test("a nick can be asked about before it is claimed, and one's own reads free", async () => {
  const { app } = buildTestApp();
  const a = await registered(app);
  // B never claims anything here, so B has no reason to have accepted: asking
  // whether a nick is free is not registering.
  const b = await signIn(app, email());
  const name = username();

  const free = await isFree(app, b.token, name);
  expect(free.statusCode).toBe(200);
  expect(free.json()).toEqual({ available: true });

  expect((await setUsername(app, a.token, name.toUpperCase())).statusCode).toBe(200);
  // Taken in any case, exactly as the claim itself is refused in any case.
  expect((await isFree(app, b.token, name)).json()).toEqual({ available: false });
  expect((await isFree(app, b.token, name.toUpperCase())).json()).toEqual({ available: false });
  // But never for its holder: sending one's own nick back unchanged — or
  // restyled — is a 200 from the POST, so it must not read «taken» here.
  expect((await isFree(app, a.token, name)).json()).toEqual({ available: true });
  expect((await isFree(app, a.token, name.toUpperCase())).json()).toEqual({ available: true });

  // Asking claims nothing: B is still without a username.
  expect((await me(app, b.token)).json()).toEqual(b.user);

  // What could never be held is refused outright — not a quiet «free» that the
  // submit would then answer 400 to, and not a 500 either.
  const unholdable = [
    "", // nobody holds an empty nick
    "ab", // under 3
    "a".repeat(31), // over 30
    "_foo", // separator at the front
    "foo.", // separator at the back
    "foo!",
    "приве", // non-ASCII
    "foo\nbar",
    `${name} `, // trailing space
    `${name}\u0000`, // NUL: the byte the database cannot compare at all
  ];
  for (const candidate of unholdable) {
    const res = await isFree(app, b.token, candidate);
    expect([candidate, res.statusCode]).toEqual([candidate, 400]);
  }
  // And leaving the parameter out altogether.
  expect(
    (await app.inject(as(b.token, { method: "GET", url: "/me/username/available" }))).statusCode,
  ).toBe(400);

  await app.close();
});

test("the language sits on the person: switched, kept, and nobody else's", async () => {
  const { app } = buildTestApp();
  const address = email();
  const a = await signIn(app, address);
  const b = await signIn(app, email());

  // A new account already has one, because what the server composes for a
  // person is composed without them — there is no «unset» to fall through to.
  expect(a.user.language).toBe("ru");

  const switched = await setLanguage(app, a.token, "en");
  expect(switched.statusCode).toBe(200);
  // Exactly the body of GET /me, as POST /me/username is.
  expect(switched.json()).toEqual({ ...a.user, language: "en" });
  expect((await me(app, a.token)).json()).toEqual(switched.json());

  // It outlives the session it was set in: the choice is on the row, which is
  // the whole reason for the column — a push has only the row to read.
  expect((await signIn(app, address)).user.language).toBe("en");
  // And it is one person's own: B is where B was.
  expect((await me(app, b.token)).json()).toEqual(b.user);

  // Back again, and saying the same thing twice is not an error.
  expect((await setLanguage(app, a.token, "ru")).json()).toEqual(a.user);
  expect((await setLanguage(app, a.token, "ru")).statusCode).toBe(200);

  await app.close();
});

test("there is no third language: anything else is refused before the database", async () => {
  const { app } = buildTestApp();
  const { token } = await signIn(app, email());

  const bad = [
    "fr", // a third language
    "RU", // the right one, miscased — the column's CHECK would refuse it too
    "ru-RU", // a full tag, not the subtag
    "russian",
    "", // nothing
    "ru en",
    "ru\n",
    // Not strings at all. An *array* is missing on purpose: fastify's ajv runs
    // with coerceTypes 'array', so `["ru"]` arrives as "ru" — which the enum
    // then passes, and it is one of the two values either way.
    null,
    true,
    7,
  ];
  for (const candidate of bad) {
    const res = await setLanguage(app, token, candidate);
    expect([candidate, res.statusCode]).toEqual([candidate, 400]);
  }
  // And a body without the field at all.
  expect((await app.inject(as(token, { method: "POST", url: "/me/language" }))).statusCode).toBe(
    400,
  );
  // None of that touched the row.
  expect((await me(app, token)).json()).toMatchObject({ language: "ru" });

  await app.close();
});

test("«dates between days» is the account's: off at first, switched both ways, kept, nobody else's", async () => {
  const { app } = buildTestApp();
  const address = email();
  const a = await signIn(app, address);
  const b = await signIn(app, email());

  // Off for a new account, and a real `false` rather than a missing field: the
  // app has no third «not set» to make sense of.
  expect(a.user.dates_between_days).toBe(false);

  const on = await setDatesBetweenDays(app, a.token, true);
  expect(on.statusCode).toBe(200);
  // Exactly the body of GET /me, as POST /me/language is.
  expect(on.json()).toEqual({ ...a.user, dates_between_days: true });
  expect((await me(app, a.token)).json()).toEqual(on.json());

  // A new sign-in is a new session and a new token; the choice is on neither,
  // it is on the account, so it is already there.
  const again = await signIn(app, address);
  expect(again.user).toEqual(on.json());
  // One per account: B is where B was.
  expect((await me(app, b.token)).json()).toEqual(b.user);

  // Back again from the other token, seen from the first — and saying the
  // same thing twice is not an error.
  expect((await setDatesBetweenDays(app, again.token, false)).json()).toEqual(a.user);
  expect((await me(app, a.token)).json()).toEqual(a.user);
  expect((await setDatesBetweenDays(app, a.token, false)).statusCode).toBe(200);

  await app.close();
});

test("«dates between days» takes a JSON boolean and nothing that merely looks like one", async () => {
  const { app } = buildTestApp();
  const { token } = await signIn(app, email());

  const bad = [
    // Each of these Fastify's ajv would coerce into a boolean if the schema
    // declared the type — which is why it does not (see identity.ts).
    "true",
    "false",
    1,
    0,
    null,
    [true],
    // And the plainly wrong.
    "",
    "yes",
    {},
  ];
  for (const candidate of bad) {
    const res = await setDatesBetweenDays(app, token, candidate);
    expect([candidate, res.statusCode]).toEqual([candidate, 400]);
  }
  // A body without the field, and the field under the name the app might
  // guess instead.
  for (const payload of [undefined, { datesBetweenDays: true }]) {
    const res = await app.inject(
      as(token, { method: "POST", url: "/me/dates-between-days", payload }),
    );
    expect([payload, res.statusCode]).toEqual([payload, 400]);
  }
  // None of that touched the row.
  expect((await me(app, token)).json()).toMatchObject({ dates_between_days: false });

  await app.close();
});

test("GET /users finds a nick whatever its case, and 404s an unknown one", async () => {
  const { app } = buildTestApp();
  const a = await registered(app);
  const b = await signIn(app, email());
  const name = username();
  await setUsername(app, a.token, name.toUpperCase());

  const found = await lookup(app, b.token, name.toLowerCase());
  expect(found.statusCode).toBe(200);
  // Three fields and no more: a nick can be guessed, so it must not be a way
  // to pull out an address.
  expect(found.json()).toEqual({ id: a.user.id, username: name.toUpperCase(), name: null });
  expect((await lookup(app, b.token, name.toUpperCase())).json()).toEqual(found.json());

  const missing = await lookup(app, b.token, username());
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: "not found" });

  // citext is not the exact match it looks like — it folds through the
  // database's own `lower()`, which maps `İ` onto `i`. Proven here rather
  // than trusted, because it is the whole reason the route screens the query
  // before asking: unscreened, this fetches a real account under a homoglyph.
  const homoglyph = `${name.slice(0, -1)}İ`;
  const [fold] = await sql<{ same: boolean }[]>`
    select ${homoglyph}::citext = ${name}::citext as same
  `;
  expect(fold?.same).toBe(true);

  // So anything that could never have been registered is a 404 by definition:
  // never somebody else's row, and never a 500. The NUL byte is the one
  // Postgres cannot compare at all.
  const unholdable = [
    homoglyph,
    "\u0000", // NUL: Postgres cannot compare one at all, and answered 500
    `${name}\u0000`,
    "", // nobody holds an empty nick
    `${name} `, // trailing space
    "_leading",
    "a".repeat(31), // longer than any nick can be
    "приве",
  ];
  for (const candidate of unholdable) {
    const res = await lookup(app, b.token, candidate);
    expect([candidate, res.statusCode]).toEqual([candidate, 404]);
  }

  // Leaving the parameter out altogether is a different thing: a broken call.
  expect((await app.inject(as(b.token, { method: "GET", url: "/users" }))).statusCode).toBe(400);

  await app.close();
});

test("GET /auth/sessions lists the live ones and marks exactly one current", async () => {
  const { app } = buildTestApp();
  const address = email();
  // The same address three times: one user, three sessions.
  const [a, b, c] = [
    await signIn(app, address),
    await signIn(app, address),
    await signIn(app, address),
  ];
  const stranger = await signIn(app, email());

  const listed = await sessions(app, c.token);
  expect(listed.statusCode).toBe(200);
  const all = listed.json() as { id: string; current: boolean; created_at: string }[];
  expect(all).toHaveLength(3);
  expect(Object.keys(all[0] ?? {}).sort()).toEqual(["created_at", "current", "expires_at", "id"]);
  expect(all.filter((s) => s.current)).toHaveLength(1);

  // The one marked current is the session the calling token maps to.
  const [own] = await sql<{ id: string }[]>`
    select id from sessions where token_hash = ${hashToken(c.token)}
  `;
  expect(all.find((s) => s.current)?.id).toBe(own?.id);

  // An expired session and a revoked one both drop out of the list.
  await sql`update sessions set expires_at = now() where token_hash = ${hashToken(a.token)}`;
  await sql`update sessions set revoked_at = now() where token_hash = ${hashToken(b.token)}`;
  const live = (await sessions(app, c.token)).json() as { current: boolean }[];
  expect(live).toHaveLength(1);
  expect(live[0]?.current).toBe(true);

  // Nobody sees anybody else's.
  expect((await sessions(app, stranger.token)).json()).toHaveLength(1);

  await app.close();
});

test("revoking a session kills that token, and only its owner may do it", async () => {
  const { app } = buildTestApp();
  const address = email();
  const [phone, laptop] = [await signIn(app, address), await signIn(app, address)];
  const stranger = await signIn(app, email());

  const [target] = await sql<{ id: string }[]>`
    select id from sessions where token_hash = ${hashToken(phone.token)}
  `;
  const revokeReq = (token: string, id: string) =>
    app.inject(as(token, { method: "POST", url: `/auth/sessions/${id}/revoke` }));

  // Somebody else's session id has to look exactly like one that never existed.
  expect((await revokeReq(stranger.token, target?.id ?? "")).statusCode).toBe(404);
  expect((await me(app, phone.token)).statusCode).toBe(200);

  const revoked = await revokeReq(laptop.token, target?.id ?? "");
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json()).toEqual({ ok: true });
  expect((await me(app, phone.token)).statusCode).toBe(401);
  // The session it was called from is untouched.
  expect((await me(app, laptop.token)).statusCode).toBe(200);

  // Doing it twice is the same outcome as doing it once.
  expect((await revokeReq(laptop.token, target?.id ?? "")).statusCode).toBe(200);
  // An id nobody holds, and ones that are not an id at all. The `urn:uuid:`
  // form is here because ajv's own `uuid` format accepts it and Postgres does
  // not: it used to reach the database and come back a 500.
  expect((await revokeReq(laptop.token, randomUUID())).statusCode).toBe(404);
  for (const malformed of ["not-a-uuid", `urn:uuid:${randomUUID()}`, `${randomUUID()}x`]) {
    const res = await revokeReq(laptop.token, malformed);
    expect([malformed, res.statusCode]).toEqual([malformed, 400]);
  }

  await app.close();
});

test("logout kills the token it was called with and leaves the others alone", async () => {
  const { app } = buildTestApp();
  const address = email();
  const [phone, laptop] = [await signIn(app, address), await signIn(app, address)];

  const logout = (token: string) => app.inject(as(token, { method: "POST", url: "/auth/logout" }));

  const out = await logout(phone.token);
  expect(out.statusCode).toBe(200);
  expect(out.json()).toEqual({ ok: true });
  expect((await me(app, phone.token)).statusCode).toBe(401);
  expect((await me(app, laptop.token)).statusCode).toBe(200);

  // The dead token cannot even reach the route a second time.
  expect((await logout(phone.token)).statusCode).toBe(401);

  await app.close();
});

test("every route added here sits behind the session check", async () => {
  const { app } = buildTestApp();
  const calls: InjectOptions[] = [
    { method: "POST", url: "/me/consent" },
    { method: "POST", url: "/me/username", payload: { username: username() } },
    { method: "GET", url: `/me/username/available?username=${username()}` },
    { method: "POST", url: "/me/language", payload: { language: "en" } },
    { method: "POST", url: "/me/dates-between-days", payload: { dates_between_days: true } },
    { method: "GET", url: `/users?username=${username()}` },
    { method: "GET", url: "/auth/sessions" },
    { method: "POST", url: `/auth/sessions/${randomUUID()}/revoke` },
    { method: "POST", url: "/auth/logout" },
  ];
  for (const call of calls) {
    for (const headers of [{}, { authorization: "Bearer nonsense" }]) {
      const res = await app.inject({ ...call, headers });
      expect([call.url, res.statusCode, res.body]).toEqual([
        call.url,
        401,
        '{"error":"unauthorized"}',
      ]);
    }
  }

  await app.close();
});
