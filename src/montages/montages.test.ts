import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * The worker's half of a finished video, written by hand — it is not running.
 *
 * `poster` false is a ready video with no poster beside it: everything
 * assembled before the worker learned to cut a frame stays like this forever,
 * and the app has to read it as «постера нет», not as «ещё не готово».
 */
const assembled = (montageId: string, poster = true) => sql`
  update montages
  set status = 'ready', video_key = ${`montages/${montageId}.mp4`},
      poster_key = ${poster ? `montages/${montageId}.jpg` : null},
      duration_seconds = 58.5, updated_at = now()
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
    poster_url: null,
  });
  // The keys are ours, not the client's: it gets links, never keys.
  expect(montage.video_key).toBeUndefined();
  expect(montage.poster_key).toBeUndefined();

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

  // The fourth shape, and the one that is *not* the same: a zero-length body
  // under `content-type: application/json` is refused by Fastify's own JSON
  // parser before any schema of ours is consulted. Pinned here because it is
  // the shape a client produces by accident — a POST with the header set out
  // of habit and nothing to send — and the README has to name it rather than
  // promise «без тела» works whatever the headers say.
  const emptyWithType = await app.inject({
    method: "POST",
    url: `/memories/${memory.id}/montages`,
    headers: { authorization: `Bearer ${organizer.token}`, "content-type": "application/json" },
    payload: "",
  });
  expect(emptyWithType.statusCode).toBe(400);
  expect(emptyWithType.json().code).toBe("FST_ERR_CTP_EMPTY_JSON_BODY");

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
    { orientation: "square" },
    { orientation: "Portrait" },
  ]) {
    expect((await order(app, organizer.token, memory.id, payload)).statusCode).toBe(400);
  }
  const stuffed = await order(app, organizer.token, memory.id, {
    target_seconds: 45,
    style: "cinematic",
  });
  expect(stuffed.statusCode).toBe(201);
  expect(stuffed.json().params).toEqual({ target_seconds: 45 });

  // Вертикальный: the one preference that changes the shape of the video
  // (doc-03). It is written into `params` beside the length, comes back in the
  // answer to the order, and is still there when the app reads the list — the
  // worker takes it from the same place. A landscape one says nothing: an order
  // with no orientation is the row it was before this existed, above.
  const portrait = await order(app, organizer.token, memory.id, { orientation: "portrait" });
  expect(portrait.statusCode).toBe(201);
  expect(portrait.json().params).toEqual({ target_seconds: 60, orientation: "portrait" });
  const listed = (await list(app, organizer.token, memory.id)).json();
  expect(listed.find((item: { id: string }) => item.id === portrait.json().id).params).toEqual({
    target_seconds: 60,
    orientation: "portrait",
  });

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

test("the default length is held inside its own min and max, not merely inside the schema's", async () => {
  // Env is read once, at `buildApp`, into the very schema that would refuse a
  // client asking for the same number — so a default outside the band has to
  // be exercised with its own app, one built after the variable is set.
  const previous = {
    default: process.env.MONTAGE_TARGET_SECONDS,
    min: process.env.MONTAGE_TARGET_SECONDS_MIN,
    max: process.env.MONTAGE_TARGET_SECONDS_MAX,
  };
  try {
    process.env.MONTAGE_TARGET_SECONDS_MIN = "15";
    process.env.MONTAGE_TARGET_SECONDS_MAX = "300";

    // Past the ceiling — a typo in the environment, not an intent for a
    // ten-minute video nobody could have asked the schema for.
    process.env.MONTAGE_TARGET_SECONDS = "600";
    const over = buildTestApp().app;
    const overOrganizer = await signIn(over, email());
    const overMemory = await createMemory(over, overOrganizer.token);
    await material(overMemory.id, overOrganizer.user.id, 3);
    const overAnswer = await order(over, overOrganizer.token, overMemory.id, {});
    expect(overAnswer.statusCode).toBe(201);
    expect(overAnswer.json().params).toEqual({ target_seconds: 300 });
    await over.close();

    // Under the floor, the same way.
    process.env.MONTAGE_TARGET_SECONDS = "5";
    const under = buildTestApp().app;
    const underOrganizer = await signIn(under, email());
    const underMemory = await createMemory(under, underOrganizer.token);
    await material(underMemory.id, underOrganizer.user.id, 3);
    const underAnswer = await order(under, underOrganizer.token, underMemory.id, {});
    expect(underAnswer.statusCode).toBe(201);
    expect(underAnswer.json().params).toEqual({ target_seconds: 15 });
    await under.close();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = `MONTAGE_TARGET_SECONDS${key === "default" ? "" : `_${key.toUpperCase()}`}`;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
  const oldest = (await order(app, organizer.token, memory.id, {})).json();
  const first = (await order(app, organizer.token, memory.id, {})).json();
  const second = (await order(app, organizer.token, memory.id, {})).json();
  const third = (await order(app, organizer.token, memory.id, {})).json();
  // Another memory's video must not show up in this one's list.
  const other = (await order(app, organizer.token, elsewhere.id, {})).json();
  await assembled(first.id);
  await fell(second.id);
  await assembled(oldest.id, false);

  // Every standing sees the same list, a viewer above all: the matrix gives
  // them «смотреть галерею и ролики».
  for (const token of [organizer.token, contributor.token, viewer.token]) {
    const seen = await list(app, token, memory.id);
    expect(seen.statusCode).toBe(200);
    const items = seen.json();
    // Newest first — the opposite of the gallery, which reads in the order the
    // video plays; here the last one ordered is the one being waited for.
    expect(items.map((item: { id: string }) => item.id)).toEqual([
      third.id,
      second.id,
      first.id,
      oldest.id,
    ]);
    expect(items.some((item: { id: string }) => item.id === other.id)).toBe(false);

    const [queued, failed, ready, posterless] = items;
    expect(queued).toMatchObject({
      status: "queued",
      video_url: null,
      poster_url: null,
      error_text: null,
    });
    // The reason it fell is what the organizer's «повторить» stands next to.
    expect(failed).toMatchObject({
      status: "failed",
      video_url: null,
      poster_url: null,
      error_text: "ffmpeg said no",
    });
    expect(ready).toMatchObject({ status: "ready", duration_seconds: 58.5 });
    // Neither key goes out, only the links signed from them.
    expect(ready.video_key).toBeUndefined();
    expect(ready.poster_key).toBeUndefined();

    // The poster is signed exactly as the video is, and for the same 15
    // minutes the gallery hands out (R2_DOWNLOAD_TTL_SECONDS).
    for (const [link, key] of [
      [ready.video_url, `montages/${first.id}.mp4`],
      [ready.poster_url, `montages/${first.id}.jpg`],
    ]) {
      const url = new URL(link);
      expect(url.pathname).toContain(key);
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    }

    // Watchable, with nothing to show before it plays: the video assembled
    // before the worker learned to cut a frame keeps its link and answers
    // `null` for the poster alone.
    expect(posterless).toMatchObject({ status: "ready", poster_url: null });
    expect(posterless.video_url).toContain(`montages/${oldest.id}.mp4`);
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

test("without a bucket the list says so, the way the gallery does", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, 3);
  await order(app, organizer.token, memory.id, {});

  const previous = process.env.R2_ENDPOINT;
  try {
    delete process.env.R2_ENDPOINT;
    const answer = await list(app, organizer.token, memory.id);
    expect(answer.statusCode).toBe(503);
    expect(answer.json()).toEqual({ error: "storage not configured" });
  } finally {
    if (previous === undefined) delete process.env.R2_ENDPOINT;
    else process.env.R2_ENDPOINT = previous;
  }

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
    poster_url: null,
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

  // No session at all — the same 401 the other three routes give, and no row
  // moved behind it.
  const anonymous = await app.inject({
    method: "POST",
    url: `/memories/${memory.id}/montages/${montage.id}/retry`,
  });
  expect(anonymous.statusCode).toBe(401);
  expect(await jobsFor(montage.id)).toHaveLength(2);

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

    // A row nobody has rendered yet. The secret is right, the id is real, and
    // the answer is still 404: this route only knows how to say «готов», so a
    // knock over a `queued` row must not light up the memory's phones.
    const unrendered = (await order(app, organizer.token, memory.id, {})).json();
    const early = await knock(app, unrendered.id, "s3cret");
    expect(early.statusCode).toBe(404);
    expect(early.body).toBe('{"error":"not found"}');

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
            message?: { body: { ru: string; en: string }; data: unknown };
          },
      )
      .findLast((l) => l.msg === "montage push not sent");
    expect(logged?.message?.body?.ru).toContain(memory.title);
    expect(logged?.message?.body?.ru).toContain("готов");
    // Both languages are composed before anyone is picked out of the memory —
    // its members do not share one, so the send carries both (doc-8).
    expect(logged?.message?.body?.en).toContain(memory.title);
    expect(logged?.message?.body?.en).toContain("is ready");
    // Both ids: the app opens the memory's videos and puts this one on top.
    expect(logged?.message?.data).toEqual({ memoryId: memory.id, montageId: montage.id });
    // Two phones out of three members — everyone in the memory who has one, and
    // the person who ordered it is not the only one told (doc-03).
    expect(logged?.devices).toBe(2);

    // The scheme is case-insensitive here because it is everywhere else in the
    // service (RFC 7235, and clients do send it lowercase): the same header
    // must not open the session routes and get turned away by this one.
    const lowercase = await app.inject({
      method: "POST",
      url: `/internal/montages/${montage.id}/ready`,
      headers: { authorization: "bearer s3cret" },
    });
    expect(lowercase.statusCode).toBe(200);

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

test("a memory with more devices than Expo takes at once is told in slices", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, 3);
  const montage = (await order(app, organizer.token, memory.id, {})).json();
  await assembled(montage.id);

  // One over Expo's ceiling of 100 messages per request. Sent whole it would
  // come back 400 and nobody at all would hear about the video — the wedding
  // this product is for is exactly the size that trips it.
  const devices = Array.from({ length: 101 }, () => ({
    token: `ExponentPushToken[${randomUUID()}]`,
    user_id: organizer.user.id,
  }));
  await sql`insert into push_tokens ${sql(devices, "token", "user_id")}`;

  // Expo, stood in for, the way auth.test.ts stands in for Resend: a host of
  // its own, so nothing here needs a way out to the internet. It counts how
  // many messages each request carried.
  const batches: number[] = [];
  const expo = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      batches.push(JSON.parse(Buffer.concat(chunks).toString()).length);
      response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
    });
  });
  await new Promise<void>((resolve) => {
    expo.listen(0, "127.0.0.1", resolve);
  });

  const previousToken = process.env.INTERNAL_WORKER_TOKEN;
  const previousPush = process.env.EXPO_PUSH_URL;
  try {
    process.env.INTERNAL_WORKER_TOKEN = "s3cret";
    process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(expo.address() as AddressInfo).port}`;
    expect((await knock(app, montage.id, "s3cret")).statusCode).toBe(200);
  } finally {
    if (previousToken === undefined) delete process.env.INTERNAL_WORKER_TOKEN;
    else process.env.INTERNAL_WORKER_TOKEN = previousToken;
    if (previousPush === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previousPush;
    expo.close();
  }

  expect(batches).toEqual([100, 1]);

  await sql`delete from push_tokens where token in ${sql(devices.map((d) => d.token))}`;
  await app.close();
});

test("members who read different languages are each told in their own", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const guest = await member(app, memory.id, "viewer", organizer.user.id);
  await material(memory.id, organizer.user.id, 3);
  const montage = (await order(app, organizer.token, memory.id, {})).json();
  await assembled(montage.id);

  // The case a memory is full of and the invite path never sees: its members
  // are one person's guests, not one country's, so one send has to carry both
  // languages at once (doc-8). Each says which they read the way the app does,
  // then registers a phone.
  const russian = `ExponentPushToken[${randomUUID()}]`;
  const english = `ExponentPushToken[${randomUUID()}]`;
  for (const [who, language, device] of [
    [organizer, "ru", russian],
    [guest, "en", english],
  ] as const) {
    const chose = await app.inject(
      as(who.token, { method: "POST", url: "/me/language", payload: { language } }),
    );
    expect(chose.statusCode).toBe(200);
    const registered = await app.inject(
      as(who.token, { method: "POST", url: "/me/push-tokens", payload: { token: device } }),
    );
    expect(registered.statusCode).toBe(200);
  }

  // Expo stood in for, as above — this one keeps every message of every
  // request, so both who was told and what they were told are readable.
  const requests: { to: string; body: string }[][] = [];
  const expo = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
    });
  });
  await new Promise<void>((resolve) => {
    expo.listen(0, "127.0.0.1", resolve);
  });

  const previousToken = process.env.INTERNAL_WORKER_TOKEN;
  const previousPush = process.env.EXPO_PUSH_URL;
  try {
    process.env.INTERNAL_WORKER_TOKEN = "s3cret";
    process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(expo.address() as AddressInfo).port}`;
    expect((await knock(app, montage.id, "s3cret")).statusCode).toBe(200);
  } finally {
    if (previousToken === undefined) delete process.env.INTERNAL_WORKER_TOKEN;
    else process.env.INTERNAL_WORKER_TOKEN = previousToken;
    if (previousPush === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previousPush;
    expo.close();
  }

  // One request, not one per language: a message of Expo's array is whole in
  // itself, so two languages cost no extra round trip and the batching stays
  // where it was — one message per device.
  expect(requests.map((batch) => batch.length)).toEqual([2]);
  const told = new Map(requests.flat().map((message) => [message.to, message.body]));
  expect(told.get(russian)).toBe(`Ролик из «${memory.title}» готов — посмотрите и поделитесь`);
  expect(told.get(english)).toBe(
    `The movie from “${memory.title}” is ready — take a look and share it`,
  );

  await sql`delete from push_tokens where token in ${sql([russian, english])}`;
  await app.close();
});
