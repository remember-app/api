import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import {
  acceptConsent,
  buildTestApp,
  cleanupTestUsers,
  signIn,
  testEmail,
} from "../auth/testing.ts";
import { sql } from "../db.ts";

const email = () => testEmail("task12");

/** As in memories.test.ts: memories go by title tag, because they do not cascade off users. */
const titleTag = "task12-test";
const title = () => `${titleTag} ${randomUUID()}`;

afterAll(async () => {
  await sql`delete from memories where title like ${`${titleTag} %`}`;
  await cleanupTestUsers("task12");
  await sql.end();
});

type App = ReturnType<typeof buildTestApp>["app"];

const as = (token: string, options: InjectOptions) => ({
  ...options,
  headers: { authorization: `Bearer ${token}` },
});

const start = "2026-09-02T18:00:00+03:00";

/** A signed-in person who holds a username — invite-by-username needs one. */
async function person(app: App) {
  const { token, user } = await signIn(app, email());
  // Taking a nick for the first time is registering, and registering needs the
  // agreement accepted (src/auth/identity.ts).
  await acceptConsent(app, token);
  const username = `t12${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const named = await app.inject(
    as(token, { method: "POST", url: "/me/username", payload: { username } }),
  );
  expect(named.statusCode).toBe(200);
  return { token, id: user.id, username };
}

/** A memory with its organizer, ready to invite into. */
const createMemory = async (app: App, token: string) => {
  const created = await app.inject(
    as(token, {
      method: "POST",
      url: "/memories",
      payload: { title: title(), event_start: start },
    }),
  );
  expect(created.statusCode).toBe(201);
  return created.json();
};

const invite = (app: App, token: string, memoryId: string, payload: Record<string, unknown>) =>
  app.inject(as(token, { method: "POST", url: `/memories/${memoryId}/members`, payload }));

const getLink = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/invite` }));

const rotateLink = (app: App, token: string, memoryId: string, payload = {}) =>
  app.inject(as(token, { method: "POST", url: `/memories/${memoryId}/invite`, payload }));

const accept = (app: App, token: string, inviteToken: string) =>
  app.inject(
    as(token, { method: "POST", url: "/invites/accept", payload: { token: inviteToken } }),
  );

const remove = (app: App, token: string, memoryId: string, userId: string) =>
  app.inject(as(token, { method: "DELETE", url: `/memories/${memoryId}/members/${userId}` }));

const roster = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/members` }));

const setStatus = (app: App, token: string, memoryId: string, status: unknown) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/contribution-status`,
      payload: { status },
    }),
  );

const roleOf = (memoryId: string, userId: string) =>
  sql<{ role: string }[]>`
    select role from memory_members where memory_id = ${memoryId} and user_id = ${userId}
  `.then((rows) => rows[0]?.role);

const statusOf = (memoryId: string, userId: string) =>
  sql<{ status: string }[]>`
    select status from memory_members where memory_id = ${memoryId} and user_id = ${userId}
  `.then((rows) => rows[0]?.status);

/**
 * Pushes never leave the test machine: this points the sender at a port
 * nothing listens on, which is refused at once rather than hanging.
 */
const deadPushHost = "http://127.0.0.1:1/push";

test("who may invite by username: viewer may not, contributor and organizer may", async () => {
  const { app } = buildTestApp();
  const organizer = await person(app);
  const contributor = await person(app);
  const viewer = await person(app);
  const invitee = await person(app);
  const created = await createMemory(app, organizer.token);

  // The organizer invites the other two, which is also the happy path.
  for (const [who, role] of [
    [contributor, "contributor"],
    [viewer, "viewer"],
  ] as const) {
    const added = await invite(app, organizer.token, created.id, {
      username: who.username,
      role,
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toEqual({ id: who.id, username: who.username, name: null, role });
  }

  // A viewer may look and nothing else — 403, and nobody was added.
  const refused = await invite(app, viewer.token, created.id, {
    username: invitee.username,
    role: "viewer",
  });
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).toEqual({ error: "forbidden" });
  expect(await roleOf(created.id, invitee.id)).toBeUndefined();

  // A contributor may invite: the matrix gives them «звать людей».
  const byContributor = await invite(app, contributor.token, created.id, {
    username: invitee.username,
    role: "viewer",
  });
  expect(byContributor.statusCode).toBe(200);
  expect(await roleOf(created.id, invitee.id)).toBe("viewer");

  // …and `invited_by` records who did it, not the organizer.
  const [row] = await sql<{ invited_by: string }[]>`
    select invited_by from memory_members
    where memory_id = ${created.id} and user_id = ${invitee.id}
  `;
  expect(row?.invited_by).toBe(contributor.id);

  // A stranger to the memory gets the house 404, not a 403: whether this
  // memory exists is not answerable to a non-member.
  const stranger = await person(app);
  const byStranger = await invite(app, stranger.token, created.id, {
    username: invitee.username,
    role: "viewer",
  });
  expect(byStranger.statusCode).toBe(404);
  expect(byStranger.body).toBe('{"error":"not found"}');

  await app.close();
});

test("inviting twice changes nothing, and an unknown username is a 404", async () => {
  const { app } = buildTestApp();
  const organizer = await person(app);
  const invitee = await person(app);
  const created = await createMemory(app, organizer.token);

  const first = await invite(app, organizer.token, created.id, {
    username: invitee.username,
    role: "contributor",
  });
  expect(first.statusCode).toBe(200);

  // Re-adding at a different level does not move them: the answer carries the
  // role they actually hold, not the one that was asked for.
  const again = await invite(app, organizer.token, created.id, {
    username: invitee.username,
    role: "viewer",
  });
  expect(again.statusCode).toBe(200);
  expect(again.json().role).toBe("contributor");
  expect(await roleOf(created.id, invitee.id)).toBe("contributor");

  // The organizer «invited» into their own memory keeps being the organizer.
  const [me] = await sql<{ username: string }[]>`
    select username from users where id = ${organizer.id}
  `;
  const self = await invite(app, organizer.token, created.id, {
    username: me?.username ?? "",
    role: "viewer",
  });
  expect(self.statusCode).toBe(200);
  expect(await roleOf(created.id, organizer.id)).toBe("organizer");

  // Nobody by that name, and a name nobody could ever register: one answer.
  for (const username of [`t12${randomUUID().replace(/-/g, "").slice(0, 20)}`, "не ник"]) {
    const missing = await invite(app, organizer.token, created.id, {
      username,
      role: "viewer",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe('{"error":"not found"}');
  }

  // `organizer` is not a level a link or an invite may hand out.
  const asOrganizer = await invite(app, organizer.token, created.id, {
    username: invitee.username,
    role: "organizer",
  });
  expect(asOrganizer.statusCode).toBe(400);

  await app.close();
});

test("the invite link is minted once, comes back the same, and rotation kills the old one", async () => {
  const { app } = buildTestApp();
  const organizer = await person(app);
  const created = await createMemory(app, organizer.token);

  const first = await getLink(app, organizer.token, created.id);
  expect(first.statusCode).toBe(200);
  expect(first.json().role).toBe("contributor");
  expect(first.json().token).toMatch(/^[\w-]{20,}$/);

  // Asking again is asking for the same link, not for another one.
  const second = await getLink(app, organizer.token, created.id);
  expect(second.json()).toEqual(first.json());
  const minted = await sql`select 1 from invites where memory_id = ${created.id}`;
  expect(minted.length).toBe(1);

  // Rotation: a new token, the level the caller asked for, and the old row
  // marked revoked rather than deleted.
  const rotated = await rotateLink(app, organizer.token, created.id, { role: "viewer" });
  expect(rotated.statusCode).toBe(200);
  expect(rotated.json().role).toBe("viewer");
  expect(rotated.json().token).not.toBe(first.json().token);
  expect((await getLink(app, organizer.token, created.id)).json()).toEqual(rotated.json());

  // «Просто дай новую ссылку» — a POST with no body at all, which must not be
  // the 400 a bare `type: "object"` would answer with. Falls back to the
  // default level rather than keeping the one it is replacing.
  const bodyless = await app.inject(
    as(organizer.token, { method: "POST", url: `/memories/${created.id}/invite` }),
  );
  expect(bodyless.statusCode).toBe(200);
  expect(bodyless.json().role).toBe("contributor");
  expect(bodyless.json().token).not.toBe(rotated.json().token);

  const live =
    await sql`select token from invites where memory_id = ${created.id} and revoked_at is null`;
  expect(live.length).toBe(1);

  // The old token now opens nothing at all.
  const latecomer = await person(app);
  const stale = await accept(app, latecomer.token, first.json().token);
  expect(stale.statusCode).toBe(404);
  expect(stale.body).toBe('{"error":"not found"}');
  expect(await roleOf(created.id, latecomer.id)).toBeUndefined();

  await app.close();
});

test("only contributor and up may touch the link", async () => {
  const { app } = buildTestApp();
  const organizer = await person(app);
  const viewer = await person(app);
  const contributor = await person(app);
  const created = await createMemory(app, organizer.token);

  for (const [who, role] of [
    [viewer, "viewer"],
    [contributor, "contributor"],
  ] as const) {
    expect(
      (await invite(app, organizer.token, created.id, { username: who.username, role })).statusCode,
    ).toBe(200);
  }

  expect((await getLink(app, viewer.token, created.id)).statusCode).toBe(403);
  expect((await rotateLink(app, viewer.token, created.id)).statusCode).toBe(403);
  // A refused viewer must not have minted anything on the way out.
  expect((await sql`select 1 from invites where memory_id = ${created.id}`).length).toBe(0);

  expect((await getLink(app, contributor.token, created.id)).statusCode).toBe(200);
  expect((await rotateLink(app, contributor.token, created.id)).statusCode).toBe(200);

  await app.close();
});

test("accepting a link makes a member once, and says nothing about a token it does not know", async () => {
  const { app } = buildTestApp();
  const organizer = await person(app);
  const guest = await person(app);
  const created = await createMemory(app, organizer.token);

  const link = (await rotateLink(app, organizer.token, created.id, { role: "viewer" })).json();

  const joined = await accept(app, guest.token, link.token);
  expect(joined.statusCode).toBe(200);
  // The body is what `POST /memories` answers with, so the app opens the
  // memory it was deep-linked into without a second call.
  expect(joined.json()).toMatchObject({ id: created.id, title: created.title, role: "viewer" });
  expect(await roleOf(created.id, guest.id)).toBe("viewer");

  // Following the same link twice is not an error and changes nothing.
  const twice = await accept(app, guest.token, link.token);
  expect(twice.statusCode).toBe(200);
  expect(twice.json()).toEqual(joined.json());

  // The organizer following their own link keeps their role.
  const own = await accept(app, organizer.token, link.token);
  expect(own.statusCode).toBe(200);
  expect(own.json().role).toBe("organizer");

  // An unknown token is the same 404 as a revoked one.
  const unknown = await accept(app, guest.token, "not-a-token-anybody-minted");
  expect(unknown.statusCode).toBe(404);
  expect(unknown.body).toBe('{"error":"not found"}');

  // And there is no anonymous path in: the link opens the app, never a page.
  const anonymous = await app.inject({
    method: "POST",
    url: "/invites/accept",
    payload: { token: link.token },
  });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});

test("removal: the organizer shows people out, everyone else may only walk out", async () => {
  const { app } = buildTestApp();
  const organizer = await person(app);
  const contributor = await person(app);
  const viewer = await person(app);
  const created = await createMemory(app, organizer.token);

  for (const [who, role] of [
    [contributor, "contributor"],
    [viewer, "viewer"],
  ] as const) {
    expect(
      (await invite(app, organizer.token, created.id, { username: who.username, role })).statusCode,
    ).toBe(200);
  }

  // A member may not remove another member.
  const overreach = await remove(app, contributor.token, created.id, viewer.id);
  expect(overreach.statusCode).toBe(403);
  expect(overreach.json()).toEqual({ error: "forbidden" });
  expect(await roleOf(created.id, viewer.id)).toBe("viewer");

  // But may walk out on their own.
  const left = await remove(app, viewer.token, created.id, viewer.id);
  expect(left.statusCode).toBe(200);
  expect(left.json()).toEqual({ ok: true });
  expect(await roleOf(created.id, viewer.id)).toBeUndefined();
  // Gone means gone: the memory is no longer theirs to see.
  expect((await getLink(app, viewer.token, created.id)).statusCode).toBe(404);

  // The organizer shows the remaining member out.
  const excluded = await remove(app, organizer.token, created.id, contributor.id);
  expect(excluded.statusCode).toBe(200);
  expect(await roleOf(created.id, contributor.id)).toBeUndefined();

  // Removing somebody who is not there, and an id that is not a uuid at all:
  // one answer, and never a 500 from a failed cast.
  for (const target of [randomUUID(), "not-a-uuid"]) {
    const missing = await remove(app, organizer.token, created.id, target);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe('{"error":"not found"}');
  }

  // And the house rule for `:memoryId` is inherited, not re-invented: a
  // malformed one is the same 404 and not the 400 a params schema would give.
  for (const answer of await Promise.all([
    remove(app, organizer.token, "not-a-uuid", organizer.id),
    getLink(app, organizer.token, "not-a-uuid"),
    invite(app, organizer.token, "not-a-uuid", { username: viewer.username, role: "viewer" }),
  ])) {
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  // The organizer may not leave: there would be nobody left who can exclude,
  // delete or order a montage, and handing the role over is out of MVP.
  const abdicate = await remove(app, organizer.token, created.id, organizer.id);
  expect(abdicate.statusCode).toBe(409);
  expect(abdicate.json()).toEqual({ error: "organizer cannot leave the memory" });
  expect(await roleOf(created.id, organizer.id)).toBe("organizer");

  await app.close();
});

test("the roster is the whole memory, and a viewer may read it too", async () => {
  const { app } = buildTestApp();
  const organizer = await person(app);
  const contributor = await person(app);
  const viewer = await person(app);
  const created = await createMemory(app, organizer.token);

  for (const [who, role] of [
    [contributor, "contributor"],
    [viewer, "viewer"],
  ] as const) {
    expect(
      (await invite(app, organizer.token, created.id, { username: who.username, role })).statusCode,
    ).toBe(200);
  }

  // `contribution_status` is on every row from m-6: nobody here has uploaded
  // anything, so all three sit at the initial value an invite leaves behind.
  const fresh = { name: null, contribution_status: "not_started" };
  const expected = [
    { ...fresh, id: organizer.id, username: organizer.username, role: "organizer" },
    { ...fresh, id: contributor.id, username: contributor.username, role: "contributor" },
    { ...fresh, id: viewer.id, username: viewer.username, role: "viewer" },
  ].sort((a, b) => a.id.localeCompare(b.id));

  // Everyone in the memory, each with the level they actually hold — the
  // organizer among them, because they hold an ordinary membership row.
  const mine = await roster(app, organizer.token, created.id);
  expect(mine.statusCode).toBe(200);
  const sorted = (answer: typeof mine) =>
    (answer.json() as { id: string }[]).sort((a, b) => a.id.localeCompare(b.id));
  expect(sorted(mine)).toEqual(expected);

  // A `viewer` reads it as well: seeing who else was there is «смотреть», and
  // this is deliberately not gated to contributor and up.
  const theirs = await roster(app, viewer.token, created.id);
  expect(theirs.statusCode).toBe(200);
  expect(sorted(theirs)).toEqual(expected);

  // The exact `GET /users` shape and nothing more — an address above all: this
  // roster is readable by anybody who followed an invite link.
  for (const member of mine.json()) {
    expect(Object.keys(member).sort()).toEqual([
      "contribution_status",
      "id",
      "name",
      "role",
      "username",
    ]);
  }

  // A stranger and a memory that does not exist are one answer, byte for byte:
  // the house 404 the membership check already gives, not a 403 here.
  const stranger = await person(app);
  for (const answer of await Promise.all([
    roster(app, stranger.token, created.id),
    roster(app, organizer.token, randomUUID()),
    roster(app, organizer.token, "not-a-uuid"),
  ])) {
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  // Leaving takes them off it — the roster is the membership table, not a
  // record of who was ever invited.
  expect((await remove(app, viewer.token, created.id, viewer.id)).statusCode).toBe(200);
  expect(
    (await roster(app, organizer.token, created.id)).json().map((m: { id: string }) => m.id),
  ).not.toContain(viewer.id);

  await app.close();
});

// The route itself has no role gate — a status grants nothing, per members.ts — so what is worth
// pinning is that every standing may use it, an unknown value is a 400 and not a CHECK violation,
// and a non-member gets the house 404 rather than a straight write into a row that is not theirs.
// `«nothing» is overridden by an upload landing` and `«done» survives more material` are covered
// in upload.test.ts, against this same route.
test("contribution status: every standing may set it, an unknown value is refused, a stranger gets the house 404", async () => {
  const { app } = buildTestApp();
  const organizer = await person(app);
  const contributor = await person(app);
  const viewer = await person(app);
  const stranger = await person(app);
  const created = await createMemory(app, organizer.token);

  for (const [who, role] of [
    [contributor, "contributor"],
    [viewer, "viewer"],
  ] as const) {
    expect(
      (await invite(app, organizer.token, created.id, { username: who.username, role })).statusCode,
    ).toBe(200);
  }

  // Both terminal answers, from all three standings — a viewer above all, since doc-01 gives them
  // no power to upload and this is exactly the case review m-8 fixed the client's gating for.
  for (const who of [organizer, contributor, viewer]) {
    for (const status of ["nothing", "done"] as const) {
      const said = await setStatus(app, who.token, created.id, status);
      expect(said.statusCode).toBe(200);
      expect(said.json()).toEqual({ status });
      expect(await statusOf(created.id, who.id)).toBe(status);
    }
  }

  // Not one of the two terminal answers this route accepts: `not_started` and `more_coming` are
  // the api's own writes, and anything outside the four is nonsense from the client.
  for (const bogus of ["not_started", "more_coming", "maybe", ""]) {
    const refused = await setStatus(app, organizer.token, created.id, bogus);
    expect(refused.statusCode).toBe(400);
  }

  // A stranger to this memory, one that never existed, and an id that is not a uuid — the same
  // 404 the family gives everywhere else, and nothing about the attempt writes a row.
  for (const id of [created.id, randomUUID(), "not-a-uuid"]) {
    const refused = await setStatus(app, stranger.token, id, "done");
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toBe('{"error":"not found"}');
  }

  await app.close();
});

test("push tokens register idempotently and follow the device", async () => {
  const { app } = buildTestApp();
  const first = await person(app);
  const second = await person(app);
  const device = `ExponentPushToken[${randomUUID()}]`;

  const register = (token: string, payload: Record<string, unknown>) =>
    app.inject(as(token, { method: "POST", url: "/me/push-tokens", payload }));

  expect((await register(first.token, { token: device, platform: "ios" })).statusCode).toBe(200);
  // Same device again — one row, not two.
  expect((await register(first.token, { token: device, platform: "ios" })).statusCode).toBe(200);
  const rows = await sql<{ user_id: string }[]>`
    select user_id from push_tokens where token = ${device}
  `;
  expect(rows.length).toBe(1);
  expect(rows[0]?.user_id).toBe(first.id);

  // The phone changed hands: it must stop delivering the previous owner's
  // notifications rather than keep both subscribed.
  expect((await register(second.token, { token: device })).statusCode).toBe(200);
  expect(await sql`select user_id from push_tokens where token = ${device}`).toEqual([
    { user_id: second.id },
  ]);

  // Rejected shapes, and no session at all.
  expect((await register(first.token, { platform: "ios" })).statusCode).toBe(400);
  expect((await register(first.token, { token: device, platform: "web" })).statusCode).toBe(400);
  expect(
    (await app.inject({ method: "POST", url: "/me/push-tokens", payload: { token: device } }))
      .statusCode,
  ).toBe(401);

  await sql`delete from push_tokens where token = ${device}`;
  await app.close();
});

test("the invite stands even when the push cannot be sent", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await person(app);
  const invitee = await person(app);
  const created = await createMemory(app, organizer.token);
  const device = `ExponentPushToken[${randomUUID()}]`;
  expect(
    (
      await app.inject(
        as(invitee.token, { method: "POST", url: "/me/push-tokens", payload: { token: device } }),
      )
    ).statusCode,
  ).toBe(200);

  const previous = process.env.EXPO_PUSH_URL;
  process.env.EXPO_PUSH_URL = deadPushHost;
  try {
    const added = await invite(app, organizer.token, created.id, {
      username: invitee.username,
      role: "contributor",
    });
    // The send fails against a port nothing listens on, and the invite is
    // untouched by it: the membership was committed before the attempt.
    expect(added.statusCode).toBe(200);
    expect(await roleOf(created.id, invitee.id)).toBe("contributor");
    expect(lines.some((l) => l.includes("invite push failed"))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previous;
  }

  await sql`delete from push_tokens where token = ${device}`;
  await app.close();
});

test("with pushing switched off the intended notification is logged and nothing throws", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await person(app);
  const invitee = await person(app);
  const created = await createMemory(app, organizer.token);

  const previous = process.env.EXPO_PUSH_URL;
  process.env.EXPO_PUSH_URL = "";
  try {
    const added = await invite(app, organizer.token, created.id, {
      username: invitee.username,
      role: "contributor",
    });
    expect(added.statusCode).toBe(200);
    // No device registered and nowhere to send it anyway — but a developer
    // still gets to read what would have gone out, deep-link payload included.
    const logged = lines
      .map(
        (l) =>
          JSON.parse(l) as {
            msg?: string;
            message?: { body: { ru: string; en: string }; data: unknown };
          },
      )
      .findLast((l) => l.msg === "invite push not sent");
    expect(logged?.message?.body?.ru).toContain("приглашает вас в");
    expect(logged?.message?.body?.ru).toContain(created.title);
    // Names who invited them and asks for the material — decision-06's whole
    // point — without ever agreeing with the inviter's gender.
    expect(logged?.message?.body?.ru).toContain(organizer.username);
    expect(logged?.message?.body?.ru).toContain("загрузите свои фото и видео");
    expect(logged?.message?.body?.ru).not.toMatch(/добавил|добавила|пригласил|позвал/);
    // The English line says the same thing in its own words and carries the
    // same two facts — who invites, and into what.
    expect(logged?.message?.body?.en).toContain("invites you to");
    expect(logged?.message?.body?.en).toContain(created.title);
    expect(logged?.message?.body?.en).toContain(organizer.username);
    expect(logged?.message?.body?.en).not.toMatch(/[а-яА-Я]/);
    expect(logged?.message?.data).toEqual({ memoryId: created.id });
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previous;
  }

  await app.close();
});

test("an inviter with neither name nor nick is a word of the reader's own language", async () => {
  const { app, lines } = buildTestApp();
  // Signed in by email and nothing more: `name` and `username` are both null,
  // which is every account between its first sign-in and the profile screen.
  const nameless = await signIn(app, email());
  const invitee = await person(app);
  const created = await createMemory(app, nameless.token);

  const previous = process.env.EXPO_PUSH_URL;
  process.env.EXPO_PUSH_URL = "";
  try {
    expect(
      (
        await invite(app, nameless.token, created.id, {
          username: invitee.username,
          role: "viewer",
        })
      ).statusCode,
    ).toBe(200);
    const logged = lines
      .map((l) => JSON.parse(l) as { msg?: string; message?: { body: { ru: string; en: string } } })
      .findLast((l) => l.msg === "invite push not sent");
    expect(logged?.message?.body?.ru).toContain("Кто-то приглашает");
    // The whole point: the stand-in is not the Russian word left standing in
    // the middle of an English sentence.
    expect(logged?.message?.body?.en).toContain("Someone invites you to");
    expect(logged?.message?.body?.en).not.toMatch(/[а-яА-Я]/);
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previous;
  }

  await app.close();
});

test("every new route is behind the session check", async () => {
  const { app } = buildTestApp();
  const id = randomUUID();

  const answers = await Promise.all([
    app.inject({
      method: "POST",
      url: `/memories/${id}/members`,
      payload: { username: "a", role: "viewer" },
    }),
    app.inject({ method: "GET", url: `/memories/${id}/members` }),
    app.inject({ method: "GET", url: `/memories/${id}/invite` }),
    app.inject({ method: "POST", url: `/memories/${id}/invite`, payload: {} }),
    app.inject({ method: "POST", url: "/invites/accept", payload: { token: "x" } }),
    app.inject({ method: "DELETE", url: `/memories/${id}/members/${id}` }),
    app.inject({ method: "POST", url: "/me/push-tokens", payload: { token: "x" } }),
    app.inject({
      method: "POST",
      url: `/memories/${id}/contribution-status`,
      payload: { status: "done" },
    }),
  ]);
  expect(answers.map((a) => a.statusCode)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);

  await app.close();
});
