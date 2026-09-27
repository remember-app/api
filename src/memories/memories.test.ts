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

const patch = (app: App, token: string, memoryId: string, payload: Record<string, unknown>) =>
  app.inject(as(token, { method: "PATCH", url: `/memories/${memoryId}`, payload }));

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
const keyOf = (url: string) => keysOf([url])[0];

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

  const memory = (await create(app, token, { title: title(), event_start: start })).json();
  await ready(memory.id, user.id, `${titleTag}-${randomUUID()}-solo.jpg`, null);

  const original = process.env.R2_ENDPOINT;
  delete process.env.R2_ENDPOINT;
  try {
    // A ready thumbnail exists, but with nothing to sign against the answer
    // is an empty tail rather than a count that leaks the unsigned key or a
    // 500 — the same rule upload.test.ts pins for the write side. The frame
    // itself is counted all the same: the card counts rows, not links.
    const listed = await list(app, token);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      { ...memory, media_count: 1, removal_media_count: 1, recent_thumbnail_urls: [] },
    ]);
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

test("every route here is behind the session check", async () => {
  const { app } = buildTestApp();

  expect((await app.inject({ method: "GET", url: "/memories" })).statusCode).toBe(401);
  const created = await app.inject({
    method: "POST",
    url: "/memories",
    payload: { title: title(), event_start: start },
  });
  expect(created.statusCode).toBe(401);
  // The session check runs ahead of the membership check, so this is a 401 and
  // not the 404 a stranger with a session gets.
  const edited = await app.inject({
    method: "PATCH",
    url: `/memories/${randomUUID()}`,
    payload: { title: title() },
  });
  expect(edited.statusCode).toBe(401);

  await app.close();
});

test("the organizer edits the title and the window, under the rules creating holds", async () => {
  const { app } = buildTestApp();
  const { token } = await signIn(app, email());

  const memory = (
    await create(app, token, { title: title(), event_start: start, event_end: null })
  ).json();

  const name = title();
  const edited = await patch(app, token, memory.id, {
    title: `  ${name}  `,
    event_start: "2026-09-04T09:00:00+03:00",
    event_end: "2026-09-05T09:00:00+03:00",
  });
  expect(edited.statusCode).toBe(200);
  // Trimmed and normalized to UTC exactly as creating does it — the same
  // schema and the same trim, not a second copy of either.
  expect(edited.json()).toMatchObject({
    id: memory.id,
    title: name,
    event_start: "2026-09-04T06:00:00.000Z",
    event_end: "2026-09-05T06:00:00.000Z",
    role: "organizer",
    cover_media_id: null,
    cover_thumbnail_url: null,
  });
  // The answer is the card of the listing, field for field: the settings screen
  // replaces what it holds with this and asks for nothing more.
  expect((await list(app, token)).json()).toEqual([edited.json()]);

  // Only what is sent moves: the end stays where it was.
  const renamed = await patch(app, token, memory.id, { title: name });
  expect(renamed.json().event_end).toBe("2026-09-05T06:00:00.000Z");
  // And null is a value here, not an absence — it takes the end off.
  const opened = await patch(app, token, memory.id, { event_end: null });
  expect(opened.json().event_end).toBeNull();

  // The refusals creating gives, given again: blank title and a bare date —
  // and a body that touches nothing, which is not an edit at all: empty, or
  // holding only fields the route does not know (a misspelt name is the same
  // silence as no name, and must not be answered 200).
  const refusals = await Promise.all([
    patch(app, token, memory.id, { title: "   " }),
    patch(app, token, memory.id, { event_start: "2026-09-04" }),
    patch(app, token, memory.id, {}),
    patch(app, token, memory.id, { coverMediaId: randomUUID() }),
  ]);
  expect(refusals.map((r) => r.statusCode)).toEqual([400, 400, 400, 400]);

  // A backwards window is refused against the row as it will be, not against
  // what arrived: this end is before the start already stored.
  const backwards = await patch(app, token, memory.id, { event_end: "2026-09-01T00:00:00Z" });
  expect(backwards.statusCode).toBe(400);
  expect(backwards.json()).toEqual({ error: "event_end is before event_start" });

  // The other half of the same rule: moving only the start, past the end that
  // is already there.
  expect(
    (await patch(app, token, memory.id, { event_end: "2026-09-05T09:00:00+03:00" })).statusCode,
  ).toBe(200);
  const past = await patch(app, token, memory.id, { event_start: "2026-09-06T00:00:00Z" });
  expect(past.statusCode).toBe(400);
  expect(past.json()).toEqual({ error: "event_end is before event_start" });

  // None of the refusals wrote anything.
  expect((await list(app, token)).json()).toMatchObject([
    { title: name, event_start: "2026-09-04T06:00:00.000Z", event_end: "2026-09-05T06:00:00.000Z" },
  ]);

  await app.close();
});

test("editing a memory is the organizer's alone, and a stranger cannot tell it is there", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const stranger = await signIn(app, email());

  const memory = (
    await create(app, organizer.token, { title: title(), event_start: start })
  ).json();

  // A member of any other standing is refused by role — 403, and only behind a
  // passed membership check.
  for (const role of ["contributor", "viewer"] as const) {
    const member = await signIn(app, email());
    await sql`
      insert into memory_members (memory_id, user_id, role, invited_by)
      values (${memory.id}, ${member.user.id}, ${role}, ${organizer.user.id})
    `;
    const refused = await patch(app, member.token, memory.id, { title: title() });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }

  // Somebody else's memory, a memory that never was, and an id that is not a
  // uuid: one and the same 404, as everywhere in this family.
  const unseen = await Promise.all([
    patch(app, stranger.token, memory.id, { title: title() }),
    patch(app, stranger.token, randomUUID(), { title: title() }),
    patch(app, stranger.token, "not-a-uuid", { title: title() }),
  ]);
  for (const answer of unseen) {
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  // Nothing of it moved — the roster grew, and that is all.
  expect((await list(app, organizer.token)).json()).toEqual([{ ...memory, member_count: 2 }]);

  await app.close();
});

test("the cover is a ready frame of this memory, and it comes off the same way", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());

  const mine = (
    await create(app, token, { title: title(), event_start: "2026-07-01T12:00:00Z" })
  ).json();
  const other = (
    await create(app, token, { title: title(), event_start: "2026-06-01T12:00:00Z" })
  ).json();

  const coverKey = `${titleTag}-${randomUUID()}-cover.jpg`;
  const [frame] = await ready(mine.id, user.id, coverKey, "2026-07-01T13:00:00Z");
  // Still being processed: no derivative behind it, so there is nothing to draw
  // a card with.
  const [unfinished] = await ready(mine.id, user.id, null, "2026-07-01T14:00:00Z");
  const [neighbour] = await ready(
    other.id,
    user.id,
    `${titleTag}-${randomUUID()}-neighbour.jpg`,
    null,
  );
  if (!frame || !unfinished || !neighbour) throw new Error("no media row");

  // A frame of another memory, one that is not ready, and one that never
  // existed — «no such frame», all three.
  const refused = await Promise.all([
    patch(app, token, mine.id, { cover_media_id: neighbour.id }),
    patch(app, token, mine.id, { cover_media_id: unfinished.id }),
    patch(app, token, mine.id, { cover_media_id: randomUUID() }),
  ]);
  for (const answer of refused) {
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  // Not a uuid at all is the client's own bug in the body, and it never reaches
  // Postgres as a failed cast.
  expect((await patch(app, token, mine.id, { cover_media_id: "нет" })).statusCode).toBe(400);

  const chosen = await patch(app, token, mine.id, { cover_media_id: frame.id });
  expect(chosen.statusCode).toBe(200);
  expect(chosen.json().cover_media_id).toBe(frame.id);
  // A link to the derivative, signed as every other picture on the card is.
  expect(keyOf(chosen.json().cover_thumbnail_url)).toBe(coverKey);
  expect(chosen.json().cover_thumbnail_url).toContain("X-Amz-Signature=");

  // The listing carries it too, and the memory without a cover answers exactly
  // as it did before there was such a thing as a cover.
  const listed = await list(app, token);
  expect(listed.json().map((m: { id: string }) => m.id)).toEqual([mine.id, other.id]);
  const [withCover, without] = listed.json();
  expect(keyOf(withCover.cover_thumbnail_url)).toBe(coverKey);
  expect(without.cover_media_id).toBeNull();
  expect(without.cover_thumbnail_url).toBeNull();

  // Taken off by sending null, which is the same button on the same form.
  const bare = await patch(app, token, mine.id, { cover_media_id: null });
  expect(bare.statusCode).toBe(200);
  expect(bare.json().cover_media_id).toBeNull();
  expect(bare.json().cover_thumbnail_url).toBeNull();

  await app.close();
});

test("deleting the frame that is the cover takes the cover off and leaves the memory whole", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());

  const memory = (
    await create(app, token, { title: title(), event_start: "2026-08-01T12:00:00Z" })
  ).json();
  const [frame] = await ready(
    memory.id,
    user.id,
    `${titleTag}-${randomUUID()}-doomed.jpg`,
    "2026-08-01T13:00:00Z",
  );
  if (!frame) throw new Error("no media row");
  expect(
    (await patch(app, token, memory.id, { cover_media_id: frame.id })).json().cover_media_id,
  ).toBe(frame.id);

  const deleted = await app.inject(
    as(token, { method: "DELETE", url: `/memories/${memory.id}/media/${frame.id}` }),
  );
  expect(deleted.statusCode).toBe(200);

  // The memory is still there and still itself; only the cover is gone.
  const [seen] = (await list(app, token)).json();
  expect(seen).toMatchObject({
    id: memory.id,
    title: memory.title,
    cover_media_id: null,
    cover_thumbnail_url: null,
    recent_thumbnail_urls: [],
  });

  // And what doc-01 still keeps out of the MVP is out of it: the organizer
  // cannot walk out of their own memory. Deleting it whole they may — that is
  // the one way out they have, and it is `src/memories/removal.test.ts`.
  const abdicate = await app.inject(
    as(token, { method: "DELETE", url: `/memories/${memory.id}/members/${user.id}` }),
  );
  expect(abdicate.statusCode).toBe(409);
  expect((await list(app, token)).json()).toHaveLength(1);

  await app.close();
});

test("the cover goes with the person who brought it, whether they walk out or are shown out", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = (
    await create(app, organizer.token, { title: title(), event_start: "2026-08-02T12:00:00Z" })
  ).json();

  // Two contributors, each with a finished frame, put in the way an invite
  // would put them.
  const brought: { token: string; userId: string; frameId: string }[] = [];
  for (const name of ["leaves", "excluded"]) {
    const member = await signIn(app, email());
    await sql`
      insert into memory_members (memory_id, user_id, role, invited_by)
      values (${memory.id}, ${member.user.id}, 'contributor', ${organizer.user.id})
    `;
    const [frame] = await ready(
      memory.id,
      member.user.id,
      `${titleTag}-${randomUUID()}-${name}.jpg`,
      "2026-08-02T13:00:00Z",
    );
    if (!frame) throw new Error("no media row");
    brought.push({ token: member.token, userId: member.user.id, frameId: frame.id });
  }
  const [walker, shown] = brought;
  if (!walker || !shown) throw new Error("no members");

  const coverOf = async () => (await list(app, organizer.token)).json()[0].cover_media_id;
  const depart = (token: string, userId: string) =>
    app.inject(as(token, { method: "DELETE", url: `/memories/${memory.id}/members/${userId}` }));

  // The cover is the frame of somebody who then walks out: their material goes
  // with them, and the cover with it — the same rule that holds for one deleted
  // record, through the other path material leaves a memory by.
  expect(
    (await patch(app, organizer.token, memory.id, { cover_media_id: walker.frameId })).statusCode,
  ).toBe(200);
  expect(await coverOf()).toBe(walker.frameId);
  expect((await depart(walker.token, walker.userId)).statusCode).toBe(200);
  expect(await coverOf()).toBeNull();

  // And shown out by the organizer, which is the same act on the same rows.
  expect(
    (await patch(app, organizer.token, memory.id, { cover_media_id: shown.frameId })).statusCode,
  ).toBe(200);
  expect(await coverOf()).toBe(shown.frameId);
  expect((await depart(organizer.token, shown.userId)).statusCode).toBe(200);
  const [card] = (await list(app, organizer.token)).json();
  expect(card).toMatchObject({
    id: memory.id,
    cover_media_id: null,
    cover_thumbnail_url: null,
    role: "organizer",
    member_count: 1,
    recent_thumbnail_urls: [],
  });

  await app.close();
});

/**
 * A frame in exactly the state given. `ready` above ties the status to the
 * picture — a key means finished, none means not — which is the very pairing
 * the cover check has to be told apart from, half by half.
 */
const frameIn = async (
  memoryId: string,
  userId: string,
  status: "ready" | "processing" | "failed" | "pending_upload",
  thumbnailKey: string | null,
) => {
  const [row] = await sql<{ id: string }[]>`
    insert into media_items
      (memory_id, uploaded_by, kind, status, original_key, size_bytes, thumbnail_key)
    values (${memoryId}, ${userId}, 'photo', ${status}, ${`${titleTag}/original-${randomUUID()}`},
            4096, ${thumbnailKey})
    returning id
  `;
  if (!row) throw new Error("insert into media_items returned no row");
  return row.id;
};

const picture = () => `${titleTag}-${randomUUID()}-picture.jpg`;

test("a cover needs a finished frame and a picture to draw it with, each on its own, and a refused cover writes nothing", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());
  const memory = (
    await create(app, token, { title: title(), event_start: "2026-07-05T12:00:00Z" })
  ).json();

  // Each is exactly one thing short of a cover. A worker that finished and left
  // no picture, and frames with a picture that are not finished (a re-run over
  // an old frame, a failure after the thumbnail was cut, a record still in the
  // air) — so «ready» and «has a thumbnail» cannot stand in for each other.
  const shortOfOne: [string, string][] = [
    ["ready, no picture", await frameIn(memory.id, user.id, "ready", null)],
    ["failed, with a picture", await frameIn(memory.id, user.id, "failed", picture())],
    ["processing, with a picture", await frameIn(memory.id, user.id, "processing", picture())],
    ["pending, with a picture", await frameIn(memory.id, user.id, "pending_upload", picture())],
  ];
  for (const [what, id] of shortOfOne) {
    // The title rides along in the same form. The cover is checked before
    // anything is written, so it must not land while its neighbour is refused.
    const refused = await patch(app, token, memory.id, {
      title: `${titleTag} renamed`,
      cover_media_id: id,
    });
    expect(refused.statusCode, what).toBe(404);
    expect(refused.body, what).toBe('{"error":"not found"}');
  }
  expect((await list(app, token)).json()).toMatchObject([
    { id: memory.id, title: memory.title, cover_media_id: null },
  ]);

  // And the one that is both is taken.
  const finished = await frameIn(memory.id, user.id, "ready", picture());
  const chosen = await patch(app, token, memory.id, { cover_media_id: finished });
  expect(chosen.statusCode).toBe(200);
  expect(chosen.json().cover_media_id).toBe(finished);

  await app.close();
});

test("an edit that does not name the cover leaves it where it is, and the whole form lands in one request", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());
  const memory = (
    await create(app, token, { title: title(), event_start: "2026-07-06T12:00:00Z" })
  ).json();
  const firstKey = picture();
  const first = await frameIn(memory.id, user.id, "ready", firstKey);
  const second = await frameIn(memory.id, user.id, "ready", picture());

  expect((await patch(app, token, memory.id, { cover_media_id: first })).statusCode).toBe(200);

  // The form sends what was touched: a new name, or a new day, and the cover
  // the organizer never went near is still the cover — and still a link.
  for (const touched of [
    { title: `${titleTag} renamed` },
    { event_start: "2026-07-07T10:00:00Z" },
  ]) {
    const edited = await patch(app, token, memory.id, touched);
    expect(edited.statusCode).toBe(200);
    expect(edited.json().cover_media_id).toBe(first);
    expect(keyOf(edited.json().cover_thumbnail_url)).toBe(firstKey);
  }

  // Everything at once — title, both ends and a new cover, the id spelt in
  // capitals as a client may echo it. The end is the very instant of the start,
  // in another offset: an event of no length is a window (the database's own
  // check reads «not before»), and one request writes all four.
  const name = title();
  const whole = await patch(app, token, memory.id, {
    title: `  ${name}  `,
    event_start: "2026-10-01T09:00:00+03:00",
    event_end: "2026-10-01T06:00:00Z",
    cover_media_id: second.toUpperCase(),
  });
  expect(whole.statusCode).toBe(200);
  expect(whole.json()).toMatchObject({
    title: name,
    event_start: "2026-10-01T06:00:00.000Z",
    event_end: "2026-10-01T06:00:00.000Z",
    cover_media_id: second,
  });
  expect((await list(app, token)).json()).toEqual([whole.json()]);

  // The end is held to a moment as the start is — a bare date, or no date at
  // all, is a 400 here and when creating, and never a cast failing in Postgres.
  expect((await patch(app, token, memory.id, { event_end: "2026-10-05" })).statusCode).toBe(400);
  expect(
    (await create(app, token, { title: title(), event_start: start, event_end: "soon" }))
      .statusCode,
  ).toBe(400);

  // A title has a ceiling, and it is the one creating holds: 200 stays, 201 not.
  expect((await patch(app, token, memory.id, { title: "x".repeat(201) })).statusCode).toBe(400);
  const longest = await patch(app, token, memory.id, {
    title: `${titleTag} `.padEnd(200, "x"),
  });
  expect(longest.statusCode).toBe(200);

  await app.close();
});

test("with no store configured the card still answers: the cover is chosen, and there is nothing to link", async () => {
  const { app } = buildTestApp();
  const { token, user } = await signIn(app, email());
  const memory = (
    await create(app, token, { title: title(), event_start: "2026-07-08T12:00:00Z" })
  ).json();
  const finished = await frameIn(memory.id, user.id, "ready", picture());

  const original = process.env.R2_ENDPOINT;
  delete process.env.R2_ENDPOINT;
  try {
    // The main screen has to draw either way — the same rule the tail of frames
    // keeps, and the cover is a second place the signing could be reached from.
    const chosen = await patch(app, token, memory.id, { cover_media_id: finished });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json()).toMatchObject({
      cover_media_id: finished,
      cover_thumbnail_url: null,
      recent_thumbnail_urls: [],
    });

    const listed = await list(app, token);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([chosen.json()]);
  } finally {
    if (original === undefined) delete process.env.R2_ENDPOINT;
    else process.env.R2_ENDPOINT = original;
  }

  await app.close();
});
