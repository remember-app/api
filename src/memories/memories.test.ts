import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { ContributionStatus, MemberRole } from "./plugin.ts";

const email = () => testEmail("task11");

/**
 * Every memory this file makes is tagged in its title, so cleanup is by title
 * and not by owner: `memories.organizer_id` deliberately does not cascade off
 * `users`, so the shared user cleanup cannot run until these are gone.
 */
const titleTag = "task11-test";
const title = () => `${titleTag} ${randomUUID()}`;

afterAll(async () => {
  await sql`delete from memories where title like ${`${titleTag} %`}`;
  await cleanupTestUsers("task11");
  await sql.end();
});

type App = ReturnType<typeof buildTestApp>["app"];

const as = (token: string, options: InjectOptions) => ({
  ...options,
  headers: { authorization: `Bearer ${token}` },
});

const create = (app: App, token: string, payload: Record<string, unknown>) =>
  app.inject(as(token, { method: "POST", url: "/memories", payload }));

const list = (app: App, token: string) =>
  app.inject(as(token, { method: "GET", url: "/memories" }));

/**
 * A throwaway route behind the real check, which is how every later feature
 * will mount it. Added before the first inject, so it is in place by ready().
 */
function withProbe(app: App) {
  app.get(
    "/memories/:memoryId/probe",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request) => request.membership,
  );
  return (token: string, memoryId: string) =>
    app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/probe` }));
}

const start = "2026-09-02T18:00:00+03:00";

test("creating a memory needs a title and a start, and refuses a backwards window", async () => {
  const { app } = buildTestApp();
  const { token } = await signIn(app, email());

  const missingTitle = await create(app, token, { event_start: start });
  expect(missingTitle.statusCode).toBe(400);

  const missingStart = await create(app, token, { title: title() });
  expect(missingStart.statusCode).toBe(400);

  // Blank is not a title: `minLength: 1` alone would take this.
  const blank = await create(app, token, { title: "   ", event_start: start });
  expect(blank.statusCode).toBe(400);

  // Not a timestamp at all — must not reach Postgres as a cast failure.
  const notADate = await create(app, token, { title: title(), event_start: "2026-09-02" });
  expect(notADate.statusCode).toBe(400);

  // End before start, and the two are compared as instants: as plain text
  // this end sorts *after* this start ("01" > "00" at the hour), while in
  // fact being two hours earlier.
  const backwards = await create(app, token, {
    title: title(),
    event_start: "2026-09-02T00:00:00Z",
    event_end: "2026-09-02T01:00:00+03:00",
  });
  expect(backwards.statusCode).toBe(400);
  expect(backwards.json()).toEqual({ error: "event_end is before event_start" });

  // Nothing was written by any of the refusals.
  expect((await list(app, token)).json()).toEqual([]);

  await app.close();
});

test("creating a memory makes the creator its organizer, with counters at zero", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());
  const name = title();

  const created = await create(app, token, { title: `  ${name}  `, event_start: start });
  expect(created.statusCode).toBe(201);
  const memory = created.json();

  // The title is stored trimmed, and the offset is normalized to UTC.
  expect(memory.title).toBe(name);
  expect(memory.event_start).toBe("2026-09-02T15:00:00.000Z");
  expect(memory.event_end).toBeNull();
  expect(memory.organizer_id).toBe(user.id);
  expect(memory.role).toBe("organizer");
  // storage_bytes is a bigint, so it arrives as a string — pinned here
  // because the client has to parse it rather than do arithmetic on it.
  expect(memory.storage_bytes).toBe("0");
  expect(memory.media_count).toBe(0);
  expect(memory.montage_count).toBe(0);
  // A memory a moment old has no frames to show, and the field is there
  // anyway: creating answers in the same shape the listing does.
  expect(memory.recent_thumbnail_urls).toEqual([]);

  // The organizer holds an ordinary membership row: that is what makes them
  // visible to the listing and to the permission check without a special case.
  const [membership] = await sql`
    select role from memory_members where memory_id = ${memory.id} and user_id = ${user.id}
  `;
  expect(membership?.role).toBe("organizer");

  // Creating answers with exactly what listing answers, so the client can
  // prepend the one to the other.
  expect((await list(app, token)).json()).toEqual([memory]);

  await app.close();
});

test("the listing holds the caller's memories and nobody else's", async () => {
  const { app } = buildTestApp();
  const mine = await signIn(app, email());
  const theirs = await signIn(app, email());

  const older = await create(app, mine.token, {
    title: title(),
    event_start: "2026-01-01T12:00:00Z",
  });
  const newer = await create(app, mine.token, {
    title: title(),
    event_start: "2026-06-01T12:00:00Z",
    event_end: "2026-06-03T12:00:00Z",
  });
  const strangers = await create(app, theirs.token, { title: title(), event_start: start });
  expect([older, newer, strangers].map((r) => r.statusCode)).toEqual([201, 201, 201]);

  // Newest event first, and the stranger's memory is absent entirely.
  const listed = await list(app, mine.token);
  expect(listed.statusCode).toBe(200);
  expect(listed.json()).toEqual([newer.json(), older.json()]);

  // A memory one is invited into shows up with the role one was given.
  await sql`
    insert into memory_members (memory_id, user_id, role, invited_by)
    values (${strangers.json().id}, ${mine.user.id}, 'viewer', ${theirs.user.id})
  `;
  const withInvite = await list(app, mine.token);
  expect(withInvite.json().map((m: { id: string; role: string }) => [m.id, m.role])).toEqual([
    [strangers.json().id, "viewer"],
    [newer.json().id, "organizer"],
    [older.json().id, "organizer"],
  ]);

  await app.close();
});

/**
 * A record as the montage worker leaves it: `ready`, with a thumbnail behind
 * it. Written into the table rather than uploaded — that column is the
 * worker's to fill and no worker runs here, so an honest upload would leave it
 * null and prove nothing.
 */
const ready = (
  memoryId: string,
  userId: string,
  key: string | null,
  capturedAt: string | null,
) => sql<{ id: string }[]>`
  insert into media_items
    (memory_id, uploaded_by, kind, status, original_key, size_bytes, captured_at, thumbnail_key)
  values (
    ${memoryId}, ${userId}, 'photo', ${key ? "ready" : "processing"},
    ${`${titleTag}/original-${randomUUID()}`}, 4096, ${capturedAt}, ${key}
  )
  returning id
`;

/** What each signed link points at: the last segment of its path. */
const keysOf = (urls: string[]) => urls.map((url) => new URL(url).pathname.split("/").pop());

test("the listing carries the last frames of every memory in one answer", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());

  // Three memories, ordered by their event so the listing's order is fixed:
  // one with nothing in it, one with a single frame, one with a pile.
  const empty = (
    await create(app, token, { title: title(), event_start: "2026-03-01T12:00:00Z" })
  ).json();
  const single = (
    await create(app, token, { title: title(), event_start: "2026-02-01T12:00:00Z" })
  ).json();
  const pile = (
    await create(app, token, { title: title(), event_start: "2026-01-01T12:00:00Z" })
  ).json();

  const key = (name: string) => `${titleTag}-${randomUUID()}-${name}.jpg`;
  const only = key("only");
  const earliest = key("earliest");
  const oldest = key("oldest");
  const middle = key("middle");
  const newest = key("newest");
  const dateless = key("dateless");

  await ready(single.id, user.id, only, "2026-02-01T13:00:00Z");
  // Five ready frames on the pile, one more than the card draws: this is the
  // one the limit cuts, and it is the one shot first.
  await ready(pile.id, user.id, earliest, "2026-01-01T08:00:00Z");
  await ready(pile.id, user.id, oldest, "2026-01-01T10:00:00Z");
  await ready(pile.id, user.id, middle, "2026-01-01T12:00:00Z");
  await ready(pile.id, user.id, newest, "2026-01-01T14:00:00Z");
  // No capture date: it falls back to when it arrived, which is now — so this
  // is the freshest of them all, exactly as the gallery would read it.
  await ready(pile.id, user.id, dateless, null);
  // Still being worked on: no thumbnail exists yet, so it takes no slot even
  // though it was shot after every one of them.
  await ready(pile.id, user.id, null, "2026-01-01T23:00:00Z");

  // One request for the whole screen — the frames of all three memories arrive
  // together, which is the point of them riding on this listing at all.
  const listed = await list(app, token);
  expect(listed.statusCode).toBe(200);
  const seen: { id: string; recent_thumbnail_urls: string[] }[] = listed.json();
  expect(seen.map((m) => m.id)).toEqual([empty.id, single.id, pile.id]);
  expect(seen.map((m) => keysOf(m.recent_thumbnail_urls))).toEqual([
    [],
    [only],
    // Newest first, and exactly the four the card draws: `earliest` is ready
    // with a thumbnail like the rest and still does not fit.
    [dateless, newest, middle, oldest],
  ]);

  // Signed links, not bare keys: the bucket is private, and these open without
  // credentials for as long as the signature lives.
  for (const url of seen.flatMap((m) => m.recent_thumbnail_urls)) {
    expect(url).toContain("X-Amz-Signature=");
  }

  await app.close();
});

test("a tie in captured_at breaks on id, and four ready frames exactly fill the card", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());

  const memory = (
    await create(app, token, { title: title(), event_start: "2026-04-01T12:00:00Z" })
  ).json();

  const key = (name: string) => `${titleTag}-${randomUUID()}-${name}.jpg`;
  const insert = async (name: string, capturedAt: string) => {
    const k = key(name);
    const [row] = await ready(memory.id, user.id, k, capturedAt);
    if (!row) throw new Error("insert into media_items returned no row");
    return { id: row.id, key: k };
  };

  // Two moments, two frames tied on each: coalesce(captured_at, created_at)
  // alone cannot order a pair shot at the same instant, so id desc is the
  // only thing left to break it. Four rows total — as many as the card
  // draws, and the limit must not cut one of them just because it is at
  // the boundary.
  const laterA = await insert("later-a", "2026-04-01T10:00:00Z");
  const laterB = await insert("later-b", "2026-04-01T10:00:00Z");
  const earlierA = await insert("earlier-a", "2026-04-01T08:00:00Z");
  const earlierB = await insert("earlier-b", "2026-04-01T08:00:00Z");

  const byIdDesc = (a: { id: string }, b: { id: string }) => (a.id > b.id ? -1 : 1);
  const expectedKeys = [
    ...[laterA, laterB].sort(byIdDesc).map((r) => r.key),
    ...[earlierA, earlierB].sort(byIdDesc).map((r) => r.key),
  ];

  const listed = await list(app, token);
  expect(listed.statusCode).toBe(200);
  const [seen] = listed.json();
  expect(keysOf(seen.recent_thumbnail_urls)).toEqual(expectedKeys);

  await app.close();
});

test("an unconfigured bucket still answers, with empty tails and not a smaller cap", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());

  const memory = (
    await create(app, token, { title: title(), event_start: start })
  ).json();
  await ready(memory.id, user.id, `${titleTag}-${randomUUID()}-solo.jpg`, null);

  const original = process.env.R2_ENDPOINT;
  delete process.env.R2_ENDPOINT;
  try {
    // A ready thumbnail exists, but with nothing to sign against the answer
    // is an empty tail rather than a count that leaks the unsigned key or a
    // 500 — the same rule upload.test.ts pins for the write side.
    const listed = await list(app, token);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([{ ...memory, recent_thumbnail_urls: [] }]);
  } finally {
    if (original === undefined) delete process.env.R2_ENDPOINT;
    else process.env.R2_ENDPOINT = original;
  }

  await app.close();
});

test("the listing says how many members have already brought frames, and how many there are", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());

  // Nobody in it but its organizer, who has brought nothing — the empty end of
  // the card's «0 из 1». Created answers it as well as the listing does.
  const alone = (
    await create(app, organizer.token, { title: title(), event_start: "2026-05-01T12:00:00Z" })
  ).json();
  expect([alone.contributed_member_count, alone.member_count]).toEqual([0, 1]);

  const crowd = (
    await create(app, organizer.token, { title: title(), event_start: "2026-04-01T12:00:00Z" })
  ).json();
  // «это всё» and «ждать нечего» are brought, «ещё будет» is not — material is
  // still on the way (doc-06). The viewer is in `done` on purpose: under the
  // old rule this roster read 4 of 5, under the rule doc-06 fixed it is 2 of 4
  // — the viewer is out of both counts, and `more_coming` is out of the first.
  const roster: [MemberRole, ContributionStatus][] = [
    ["contributor", "more_coming"],
    ["contributor", "done"],
    ["contributor", "nothing"],
    ["viewer", "done"],
  ];
  for (const [role, status] of roster) {
    const member = await signIn(app, email());
    await sql`
      insert into memory_members (memory_id, user_id, role, invited_by, status)
      values (${crowd.id}, ${member.user.id}, ${role}, ${organizer.user.id}, ${status})
    `;
  }

  const counts = async () =>
    (await list(app, organizer.token))
      .json()
      .map((m: { id: string; contributed_member_count: number; member_count: number }) => [
        m.id,
        m.contributed_member_count,
        m.member_count,
      ]);

  // Both memories in the one answer, and neither count leaks into the other:
  // the organizer of the crowd is still in `not_started`, so it is 2 of 4.
  expect(await counts()).toEqual([
    [alone.id, 0, 1],
    [crowd.id, 2, 4],
  ]);

  // The organizer has brought theirs too — and the one member still «ещё
  // будет» keeps the bar off full, viewer or no viewer.
  await sql`
    update memory_members set status = 'done'
    where memory_id = ${crowd.id} and user_id = ${organizer.user.id}
  `;
  expect(await counts()).toEqual([
    [alone.id, 0, 1],
    [crowd.id, 3, 4],
  ]);

  // Counted as whole numbers: count() is bigint, and unless it is cast the
  // card gets "4" and "4" as strings and cannot compare them.
  const [, seen] = (await list(app, organizer.token)).json();
  expect(seen.contributed_member_count).toBeTypeOf("number");
  expect(seen.member_count).toBeTypeOf("number");

  await app.close();
});

test("the membership check hands the caller's role to the route", async () => {
  const { app } = buildTestApp();
  const probe = withProbe(app);
  const organizer = await signIn(app, email());

  const created = await create(app, organizer.token, {
    title: title(),
    event_start: start,
    event_end: null,
  });
  expect(created.statusCode).toBe(201);
  const memory = created.json();

  const roles: MemberRole[] = ["organizer", "contributor", "viewer"];
  for (const role of roles) {
    let token = organizer.token;
    if (role !== "organizer") {
      const member = await signIn(app, email());
      token = member.token;
      await sql`
        insert into memory_members (memory_id, user_id, role, invited_by)
        values (${memory.id}, ${member.user.id}, ${role}, ${organizer.user.id})
      `;
    }
    const seen = await probe(token, memory.id);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().role).toBe(role);
    // The whole memory row travels with it, organizer_id included — that is
    // what a downstream route reads instead of fetching it again.
    expect(seen.json().memory).toMatchObject({
      id: memory.id,
      organizer_id: organizer.user.id,
      title: memory.title,
    });
  }

  await app.close();
});

test("a non-member, a missing memory and a malformed id are one and the same 404", async () => {
  const { app } = buildTestApp();
  const probe = withProbe(app);
  const organizer = await signIn(app, email());
  const stranger = await signIn(app, email());

  const memory = (
    await create(app, organizer.token, { title: title(), event_start: start })
  ).json();

  // Somebody else's memory, a memory that never existed, and an id that is
  // not a uuid at all: byte for byte the same answer, or holding an id would
  // tell a stranger whether it names anything.
  const answers = await Promise.all([
    probe(stranger.token, memory.id),
    probe(stranger.token, randomUUID()),
    probe(stranger.token, "not-a-uuid"),
  ]);
  for (const answer of answers) {
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  // And it is a 401, not a 404, when there is no session at all: the check
  // never runs ahead of the session check.
  const anonymous = await app.inject({
    method: "GET",
    url: `/memories/${memory.id}/probe`,
  });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});

test("mounting the check without the session check ahead of it is a loud failure", async () => {
  const { app, lines } = buildTestApp();
  // The one way a later feature can misuse this: right decorator, wrong order.
  app.get(
    "/memories/:memoryId/misordered",
    { preHandler: app.requireMembership },
    async () => ({}),
  );
  const { token } = await signIn(app, email());

  const answer = await app.inject(
    as(token, { method: "GET", url: `/memories/${randomUUID()}/misordered` }),
  );
  // A server misconfiguration, not a bad request — and the log says which.
  expect(answer.statusCode).toBe(500);
  expect(lines.some((l) => l.includes("must be mounted after app.authenticate"))).toBe(true);

  await app.close();
});

test("both routes are behind the session check", async () => {
  const { app } = buildTestApp();

  expect((await app.inject({ method: "GET", url: "/memories" })).statusCode).toBe(401);
  const created = await app.inject({
    method: "POST",
    url: "/memories",
    payload: { title: title(), event_start: start },
  });
  expect(created.statusCode).toBe(401);

  await app.close();
});
