import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";

/**
 * Live against the real Postgres, as every test here does. No object store is
 * needed: nothing in this family uploads bytes — the worker does that — so the
 * material is written straight into `media_items` and the signed link is only
 * asked to be a signed link.
 */

const email = () => testEmail("task53");
const titleTag = "task53-test";
const title = () => `${titleTag} ${randomUUID()}`;
const mine = `${titleTag} %`;

// The queue rows go first: `jobs` belongs to montage, and only the rows this
// file put there may be taken back out.
afterAll(async () => {
  await sql`
    delete from jobs where type = 'montage' and ref in (
      select id::text from montages where memory_id in (
        select id from memories where title like ${mine}
      )
    )
  `;
  // The memories go before the people: montages.ordered_by deliberately has no
  // ON DELETE, so a user row cannot leave while a montage of theirs stands.
  await sql`delete from memories where title like ${mine}`;
  await cleanupTestUsers("task53");
  await sql.end();
});

type App = ReturnType<typeof buildTestApp>["app"];

const as = (token: string, options: InjectOptions) => ({
  ...options,
  headers: { authorization: `Bearer ${token}` },
});

const createMemory = async (app: App, token: string) => {
  const created = await app.inject(
    as(token, {
      method: "POST",
      url: "/memories",
      payload: { title: title(), event_start: "2026-09-02T18:00:00+03:00" },
    }),
  );
  expect(created.statusCode).toBe(201);
  return created.json() as { id: string; title: string };
};

/** A member of the given standing, put in the way an invite would put them. */
async function member(app: App, memoryId: string, role: MemberRole, by: string) {
  const person = await signIn(app, email());
  await sql`
    insert into memory_members (memory_id, user_id, role, invited_by)
    values (${memoryId}, ${person.user.id}, ${role}, ${by})
  `;
  return person;
}

/**
 * Material in the memory, written where the upload would have left it. The
 * status is what the order counts on, so it is the argument.
 */
async function material(
  memoryId: string,
  uploadedBy: string,
  count: number,
  status: "ready" | "processing" = "ready",
) {
  for (let n = 0; n < count; n++) {
    await sql`
      insert into media_items (memory_id, uploaded_by, kind, status, original_key, size_bytes)
      values (${memoryId}, ${uploadedBy}, 'photo', ${status}, ${`originals/${randomUUID()}`}, 4096)
    `;
  }
}

const order = (app: App, token: string, memoryId: string, payload?: object) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/montages`,
      ...(payload === undefined ? {} : { payload }),
    }),
  );

const list = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/montages` }));

const retry = (app: App, token: string, memoryId: string, montageId: string) =>
  app.inject(
    as(token, { method: "POST", url: `/memories/${memoryId}/montages/${montageId}/retry` }),
  );

/** The worker's knock. `secret` absent means it knocks with no header at all. */
const knock = (app: App, montageId: string, secret?: string) =>
  app.inject({
    method: "POST",
    url: `/internal/montages/${montageId}/ready`,
    ...(secret === undefined ? {} : { headers: { authorization: `Bearer ${secret}` } }),
  });

/** The queued jobs pointing at this montage — the worker's whole side of it. */
const jobsFor = async (montageId: string) =>
  sql<{ type: string; status: string }[]>`
    select type, status from jobs where ref = ${montageId}
  `;

const montageRows = async (memoryId: string) =>
  sql<
    { id: string; status: string }[]
  >`select id, status from montages where memory_id = ${memoryId}`;

/** What the order is counted in: the memory's tally and the orderer's. */
const counters = async (memoryId: string, userId: string) => {
  const [memory] = await sql<{ montage_count: number }[]>`
    select montage_count from memories where id = ${memoryId}
  `;
  const [user] = await sql<{ montage_count: number }[]>`
    select montage_count from user_usage where user_id = ${userId}
  `;
  return { memory: memory?.montage_count, user: user?.montage_count ?? 0 };
};

/** The worker's half of a finished video, written by hand — it is not running. */
const assembled = (montageId: string) => sql`
  update montages
  set status = 'ready', video_key = ${`montages/${montageId}.mp4`}, duration_seconds = 58.5,
      updated_at = now()
  where id = ${montageId}
`;

const fell = (montageId: string) => sql`
  update montages set status = 'failed', error_text = 'ffmpeg said no', updated_at = now()
  where id = ${montageId}
`;

test("the montage is ordered by the organizer alone, and only out of real material", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());

  // Nothing uploaded at all, then two files and one still being processed:
  // below three `ready` there is nothing to cut, and the refusal leaves no row
  // and no job behind — not a montage queued to fail an hour later.
  const empty = await order(app, organizer.token, memory.id, {});
  expect(empty.statusCode).toBe(409);
  expect(empty.json()).toEqual({
    error: "not enough material for a montage",
    ready_items: 0,
    need: 3,
  });

  await material(memory.id, organizer.user.id, 2);
  await material(memory.id, contributor.user.id, 1, "processing");
  const thin = await order(app, organizer.token, memory.id, {});
  expect(thin.statusCode).toBe(409);
  expect(thin.json()).toMatchObject({ ready_items: 2 });
  expect(await montageRows(memory.id)).toEqual([]);

  // Enough material for anyone — and still nobody but the organizer may order.
  await material(memory.id, contributor.user.id, 1);
  for (const token of [contributor.token, viewer.token]) {
    const refused = await order(app, token, memory.id, {});
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }

  const asked = await order(app, organizer.token, memory.id, {
    target_seconds: 90,
    music_track_id: "calm",
  });
  expect(asked.statusCode).toBe(201);
  const montage = asked.json();
  expect(montage).toMatchObject({
    memory_id: memory.id,
    ordered_by: organizer.user.id,
    status: "queued",
    duration_seconds: null,
    error_text: null,
    params: { target_seconds: 90, music_track_id: "calm" },
    video_url: null,
  });
  // The key of the video is ours, not the client's: it gets links, never keys.
  expect(montage.video_key).toBeUndefined();

  // The worker's side of the contract: one job, of type `montage`, pointing at
  // the row by id.
  expect(await jobsFor(montage.id)).toEqual([{ type: "montage", status: "queued" }]);
  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 1, user: 1 });

  // Said nothing about length or track: the default length is written down all
  // the same, so the row is the whole answer to «какой ролик просили».
  const plain = await order(app, organizer.token, memory.id, {});
  expect(plain.statusCode).toBe(201);
  expect(plain.json().params).toEqual({ target_seconds: 60 });
  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 2, user: 2 });

  // No body at all, and a literal `null`, are the same «no preferences»: three
  // shapes a client may send, one video ordered.
  const bodiless = await order(app, organizer.token, memory.id);
  expect(bodiless.statusCode).toBe(201);
  expect(bodiless.json().params).toEqual({ target_seconds: 60 });

  const nulled = await app.inject({
    method: "POST",
    url: `/memories/${memory.id}/montages`,
    headers: { authorization: `Bearer ${organizer.token}`, "content-type": "application/json" },
    payload: "null",
  });
  expect(nulled.statusCode).toBe(201);
  expect(nulled.json().params).toEqual({ target_seconds: 60 });

  // Out of the band, off the shelf of tracks — refused by the schema before a
  // row exists. An unknown field is dropped rather than refused (the ajv of
  // this repository strips them), which is what keeps `params` ours.
  for (const payload of [
    { target_seconds: 5 },
    { target_seconds: 10_000 },
    { target_seconds: 60.5 },
    { music_track_id: "epic" },
  ]) {
    expect((await order(app, organizer.token, memory.id, payload)).statusCode).toBe(400);
  }
  const stuffed = await order(app, organizer.token, memory.id, {
    target_seconds: 45,
    style: "cinematic",
  });
  expect(stuffed.statusCode).toBe(201);
  expect(stuffed.json().params).toEqual({ target_seconds: 45 });

  // Somebody else's memory, one that never existed and an id that is not a
  // uuid: byte for byte the same answer (README, «404 один на всех»).
  for (const id of [memory.id, randomUUID(), "not-a-uuid"]) {
    const answer = await order(app, stranger.token, id, {});
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  const anonymous = await app.inject({
    method: "POST",
    url: `/memories/${memory.id}/montages`,
    payload: {},
  });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});

test("the list of montages is every member's, and only a ready one carries a link", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());
  const elsewhere = await createMemory(app, organizer.token);

  await material(memory.id, organizer.user.id, 3);
  await material(elsewhere.id, organizer.user.id, 3);
  const first = (await order(app, organizer.token, memory.id, {})).json();
  const second = (await order(app, organizer.token, memory.id, {})).json();
  const third = (await order(app, organizer.token, memory.id, {})).json();
  // Another memory's video must not show up in this one's list.
  const other = (await order(app, organizer.token, elsewhere.id, {})).json();
  await assembled(first.id);
  await fell(second.id);

  // Every standing sees the same list, a viewer above all: the matrix gives
  // them «смотреть галерею и ролики».
  for (const token of [organizer.token, contributor.token, viewer.token]) {
    const seen = await list(app, token, memory.id);
    expect(seen.statusCode).toBe(200);
    const items = seen.json();
    // Newest first — the opposite of the gallery, which reads in the order the
    // video plays; here the last one ordered is the one being waited for.
    expect(items.map((item: { id: string }) => item.id)).toEqual([third.id, second.id, first.id]);
    expect(items.some((item: { id: string }) => item.id === other.id)).toBe(false);

    const [queued, failed, ready] = items;
    expect(queued).toMatchObject({ status: "queued", video_url: null, error_text: null });
    // The reason it fell is what the organizer's «повторить» stands next to.
    expect(failed).toMatchObject({
      status: "failed",
      video_url: null,
      error_text: "ffmpeg said no",
    });
    expect(ready).toMatchObject({ status: "ready", duration_seconds: 58.5 });

    const url = new URL(ready.video_url);
    expect(url.pathname).toContain(`montages/${first.id}.mp4`);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // The same TTL the gallery hands out: 15 minutes (R2_DOWNLOAD_TTL_SECONDS).
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  }

  for (const id of [memory.id, randomUUID(), "not-a-uuid"]) {
    const answer = await list(app, stranger.token, id);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  expect(
    (await app.inject({ method: "GET", url: `/memories/${memory.id}/montages` })).statusCode,
  ).toBe(401);

  await app.close();
});

test("only the organizer repeats a montage, and only one that failed", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const elsewhere = await createMemory(app, organizer.token);

  await material(memory.id, organizer.user.id, 3);
  await material(elsewhere.id, organizer.user.id, 3);
  const montage = (await order(app, organizer.token, memory.id, {})).json();
  const stray = (await order(app, organizer.token, elsewhere.id, {})).json();
  await fell(montage.id);

  // The material is theirs; what is made of it is not.
  for (const token of [contributor.token, viewer.token]) {
    const refused = await retry(app, token, memory.id, montage.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }

  const again = await retry(app, organizer.token, memory.id, montage.id);
  expect(again.statusCode).toBe(200);
  expect(again.json()).toMatchObject({
    id: montage.id,
    status: "queued",
    error_text: null,
    video_url: null,
  });
  // The same row queued again — not a second montage — with a second job on it.
  expect(await jobsFor(montage.id)).toEqual([
    { type: "montage", status: "queued" },
    { type: "montage", status: "queued" },
  ]);
  expect((await montageRows(memory.id)).length).toBe(1);
  // The counters are about what was ordered, and nobody ordered anything twice:
  // one in this memory, two behind this person (the stray in the other memory).
  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 1, user: 2 });

  // The button pressed twice, and a montage that is merely waiting: a second
  // job on a row the worker already holds is exactly what this refuses.
  const twice = await retry(app, organizer.token, memory.id, montage.id);
  expect(twice.statusCode).toBe(409);
  expect(twice.json()).toEqual({ error: "montage has not failed", status: "queued" });
  expect((await jobsFor(montage.id)).length).toBe(2);

  // Never existed, not a uuid, and alive but in another memory — one answer for
  // all three, and the stray is untouched by having been asked about.
  for (const id of [randomUUID(), "not-a-uuid", stray.id]) {
    const answer = await retry(app, organizer.token, memory.id, id);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  expect(await jobsFor(stray.id)).toEqual([{ type: "montage", status: "queued" }]);

  await app.close();
});

test("the worker's knock needs the secret and tells the whole memory", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  // In the memory and never notified: they registered no device.
  await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  await material(memory.id, organizer.user.id, 3);
  const montage = (await order(app, organizer.token, memory.id, {})).json();
  await assembled(montage.id);

  // Two of the three carry a phone; the contributor's silence is what proves
  // the notification goes by device and not by member.
  const devices = [`ExponentPushToken[${randomUUID()}]`, `ExponentPushToken[${randomUUID()}]`];
  for (const [index, token] of [organizer.token, viewer.token].entries()) {
    const registered = await app.inject(
      as(token, { method: "POST", url: "/me/push-tokens", payload: { token: devices[index] } }),
    );
    expect(registered.statusCode).toBe(200);
  }

  const previousToken = process.env.INTERNAL_WORKER_TOKEN;
  const previousPush = process.env.EXPO_PUSH_URL;
  try {
    // Unset means shut, not open: a caller with a plausible token gets the same
    // answer as one with none.
    delete process.env.INTERNAL_WORKER_TOKEN;
    for (const secret of [undefined, "s3cret", ""]) {
      const shut = await knock(app, montage.id, secret);
      expect(shut.statusCode).toBe(401);
      expect(shut.body).toBe('{"error":"unauthorized"}');
    }

    process.env.INTERNAL_WORKER_TOKEN = "s3cret";
    for (const secret of [undefined, "", "s3cre", "s3crett", "wrong"]) {
      expect((await knock(app, montage.id, secret)).statusCode).toBe(401);
    }

    // Pushing switched off, so what would have gone out is in the log — which
    // is also the whole of what a developer sees on a machine without push.
    process.env.EXPO_PUSH_URL = "";
    const told = await knock(app, montage.id, "s3cret");
    expect(told.statusCode).toBe(200);
    expect(told.json()).toEqual({ ok: true });

    const logged = lines
      .map(
        (l) =>
          JSON.parse(l) as {
            msg?: string;
            devices?: number;
            message?: { body: string; data: unknown };
          },
      )
      .findLast((l) => l.msg === "montage push not sent");
    expect(logged?.message?.body).toContain(memory.title);
    expect(logged?.message?.body).toContain("готов");
    // Both ids: the app opens the memory's videos and puts this one on top.
    expect(logged?.message?.data).toEqual({ memoryId: memory.id, montageId: montage.id });
    // Two phones out of three members — everyone in the memory who has one, and
    // the person who ordered it is not the only one told (doc-03).
    expect(logged?.devices).toBe(2);

    // A montage nobody has, and an id that is not one: the same 404 the rest of
    // the service gives, and no notification behind it.
    for (const id of [randomUUID(), "not-a-uuid"]) {
      const missing = await knock(app, id, "s3cret");
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toBe('{"error":"not found"}');
    }

    // And with somewhere to send it that nothing answers: the video is ready
    // whether or not a phone hears about it, so the worker is still told `ok`.
    process.env.EXPO_PUSH_URL = "http://127.0.0.1:1/push";
    const undelivered = await knock(app, montage.id, "s3cret");
    expect(undelivered.statusCode).toBe(200);
    expect(undelivered.json()).toEqual({ ok: true });
    expect(lines.some((l) => l.includes("montage push failed"))).toBe(true);
  } finally {
    if (previousToken === undefined) delete process.env.INTERNAL_WORKER_TOKEN;
    else process.env.INTERNAL_WORKER_TOKEN = previousToken;
    if (previousPush === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previousPush;
  }

  await sql`delete from push_tokens where token in ${sql(devices)}`;
  await app.close();
});
