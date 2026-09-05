import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { sql } from "../db.ts";
import { hashToken } from "./session.ts";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "./testing.ts";

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

const setUsername = (app: App, token: string, name: string) =>
  app.inject(as(token, { method: "POST", url: "/me/username", payload: { username: name } }));

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

test("a username is held case-insensitively: FOO blocks foo", async () => {
  const { app, lines } = buildTestApp();
  const a = await signIn(app, lines, email());
  const b = await signIn(app, lines, email());
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
  const { app, lines } = buildTestApp();
  const a = await signIn(app, lines, email());
  const b = await signIn(app, lines, email());
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
  const { app, lines } = buildTestApp();
  const { token } = await signIn(app, lines, email());
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
  const { app, lines } = buildTestApp();
  const a = await signIn(app, lines, email());
  const b = await signIn(app, lines, email());
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

test("GET /users finds a nick whatever its case, and 404s an unknown one", async () => {
  const { app, lines } = buildTestApp();
  const a = await signIn(app, lines, email());
  const b = await signIn(app, lines, email());
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
  const { app, lines } = buildTestApp();
  const address = email();
  // The same address three times: one user, three sessions.
  const [a, b, c] = [
    await signIn(app, lines, address),
    await signIn(app, lines, address),
    await signIn(app, lines, address),
  ];
  const stranger = await signIn(app, lines, email());

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
  const { app, lines } = buildTestApp();
  const address = email();
  const [phone, laptop] = [await signIn(app, lines, address), await signIn(app, lines, address)];
  const stranger = await signIn(app, lines, email());

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
  const { app, lines } = buildTestApp();
  const address = email();
  const [phone, laptop] = [await signIn(app, lines, address), await signIn(app, lines, address)];

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
    { method: "POST", url: "/me/username", payload: { username: username() } },
    { method: "GET", url: `/me/username/available?username=${username()}` },
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
