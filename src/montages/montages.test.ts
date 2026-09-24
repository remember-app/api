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
 * status is what the order counts on, so it is the argument. Answers with the
 * ids, which is what «включить этот кадр» is said with.
 *
 * Two-minute videos unless asked otherwise, because the length a montage may be
 * ordered at is cut from the material itself: three photos are worth six
 * seconds and would refuse every order in this file that names a minute.
 * Photos, and videos of a given length, are asked for where they are the point.
 */
async function material(
  memoryId: string,
  uploadedBy: string,
  count: number,
  status: "ready" | "processing" = "ready",
  kind: "photo" | "video" = "video",
  seconds: number | null = 120,
) {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const [row] = await sql<{ id: string }[]>`
      insert into media_items (
        memory_id, uploaded_by, kind, status, original_key, size_bytes, duration_seconds
      )
      values (
        ${memoryId}, ${uploadedBy}, ${kind}, ${status}, ${`originals/${randomUUID()}`}, 4096,
        ${kind === "video" ? seconds : null}
      )
      returning id
    `;
    if (row) ids.push(row.id);
  }
  return ids;
}

/**
 * The отсев's verdict on a frame, written where the worker leaves it
 * (`screening.py`): a reason is «отсеять», `null` is «оставить».
 */
const screened = (id: string, reason: string | null) => sql`
  update media_items set screening_rejected = ${reason !== null}, screening_reason = ${reason}
  where id = ${id}
`;

/**
 * A track of the organizer's own, written where its upload would have left it
 * (`music.ts`); answers with the key the order names it by.
 */
async function track(
  memoryId: string,
  uploadedBy: string,
  status: "ready" | "pending_upload" = "ready",
) {
  const key = `music/${randomUUID()}`;
  await sql`
    insert into music_uploads (memory_id, uploaded_by, status, object_key, size_bytes)
    values (${memoryId}, ${uploadedBy}, ${status}, ${key}, 4096)
  `;
  return key;
}

const order = (app: App, token: string, memoryId: string, payload?: object) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/montages`,
      ...(payload === undefined ? {} : { payload }),
    }),
  );

/** The same order, asked about instead of placed — «итог перед монтажом». */
const preview = (app: App, token: string, memoryId: string, payload?: object) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/montages/preview`,
      ...(payload === undefined ? {} : { payload }),
    }),
  );

const list = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/montages` }));

const retry = (app: App, token: string, memoryId: string, montageId: string) =>
  app.inject(
    as(token, { method: "POST", url: `/memories/${memoryId}/montages/${montageId}/retry` }),
  );

/** «Как собирался» — the journal route, asked here about what retry left it. */
const journal = (app: App, token: string, memoryId: string, montageId: string) =>
  app.inject(
    as(token, { method: "GET", url: `/memories/${memoryId}/montages/${montageId}/journal` }),
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

/** The worker has picked the job up and is at it. */
const running = (montageId: string) => sql`
  update montages set status = 'processing', updated_at = now() where id = ${montageId}
`;

/**
 * A stage row, as the worker lays it down when it reaches that stage — the
 * only hand that ever writes one (`montage_stages`, миграция 130).
 */
const stage = (montageId: string, key: string, state: string) => sql`
  insert into montage_stages (montage_id, stage, state) values (${montageId}, ${key}, ${state})
  on conflict (montage_id, stage) do update set state = ${state}, updated_at = now()
`;

/** A line the worker said while it was at this montage, written by its hand. */
const said = (montageId: string, key: string, thought: string) => sql`
  insert into montage_journal_entries (montage_id, stage, thought)
  values (${montageId}, ${key}, ${thought})
`;

/** How much of the journal stands behind this montage — lines and stages. */
const journalOf = async (montageId: string) => {
  const [row] = await sql<{ lines: number; stages: number }[]>`
    select
      (select count(*)::int from montage_journal_entries where montage_id = ${montageId}) as lines,
      (select count(*)::int from montage_stages where montage_id = ${montageId}) as stages
  `;
  return row;
};

/** Who the journal counts as watching this montage right now. */
const watching = async (montageId: string) => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from montage_viewers where montage_id = ${montageId}
  `;
  return row?.n ?? 0;
};

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
    music_tracks: ["calm"],
  });
  expect(asked.statusCode).toBe(201);
  const montage = asked.json();
  expect(montage).toMatchObject({
    memory_id: memory.id,
    ordered_by: organizer.user.id,
    status: "queued",
    duration_seconds: null,
    error_text: null,
    params: { target_seconds: 90, music_tracks: ["calm"] },
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

  // Said nothing about length or music: the default length is written down all
  // the same, so the row is the whole answer to «какой ролик просили» — and so
  // is the empty list of tracks, which is «без музыки» said out loud rather
  // than left for the worker to read as «поля нет, играй warm».
  const plain = await order(app, organizer.token, memory.id, {});
  expect(plain.statusCode).toBe(201);
  expect(plain.json().params).toEqual({ target_seconds: 60, music_tracks: [] });
  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 2, user: 2 });

  // No body at all, and a literal `null`, are the same «no preferences»: three
  // shapes a client may send, one video ordered.
  const bodiless = await order(app, organizer.token, memory.id);
  expect(bodiless.statusCode).toBe(201);
  expect(bodiless.json().params).toEqual({ target_seconds: 60, music_tracks: [] });

  // The fourth shape, and the one that is *not* the same: a zero-length body
  // under `content-type: application/json` is refused by Fastify's own JSON
  // parser before any schema of ours is consulted. Pinned here because it is
  // the shape a client produces by accident — a POST with the header set out
  // of habit and nothing to send — and the docs have to name it rather than
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
  expect(nulled.json().params).toEqual({ target_seconds: 60, music_tracks: [] });

  // Out of the band, half a second, off the shelf of tracks — refused before a
  // row exists, the first two by this memory's own ceiling and the rest by the
  // schema. An unknown field is dropped rather than refused (the ajv of this
  // repository strips them), which is what keeps `params` ours.
  for (const payload of [
    { target_seconds: 5 },
    { target_seconds: 10_000 },
    { target_seconds: 60.5 },
    { orientation: "square" },
    { orientation: "Portrait" },
  ]) {
    expect((await order(app, organizer.token, memory.id, payload)).statusCode).toBe(400);
  }
  // The two fields the app used to name one track by are refused by name: an
  // order that asked for music must not quietly become one without it.
  for (const payload of [{ music_track_id: "calm" }, { music_track_key: "music/whatever" }]) {
    const old = await order(app, organizer.token, memory.id, payload);
    expect(old.statusCode).toBe(400);
    expect(old.json().message).toContain(Object.keys(payload)[0]);
  }
  const stuffed = await order(app, organizer.token, memory.id, {
    target_seconds: 45,
    style: "cinematic",
  });
  expect(stuffed.statusCode).toBe(201);
  expect(stuffed.json().params).toEqual({ target_seconds: 45, music_tracks: [] });

  // Вертикальный: the one preference that changes the shape of the video
  // (doc-03). It is written into `params` beside the length, comes back in the
  // answer to the order, and is still there when the app reads the list — the
  // worker takes it from the same place.
  const portrait = await order(app, organizer.token, memory.id, { orientation: "portrait" });
  expect(portrait.statusCode).toBe(201);
  const vertical = portrait.json();
  expect(vertical.params).toEqual({
    target_seconds: 60,
    music_tracks: [],
    orientation: "portrait",
  });
  const listed = (await list(app, organizer.token, memory.id)).json();
  expect(listed.find((item: { id: string }) => item.id === vertical.id)?.params).toEqual({
    target_seconds: 60,
    music_tracks: [],
    orientation: "portrait",
  });

  // Asked for outright, the horizontal one is written down too — it is a choice
  // somebody made, and a row says which. Saying nothing is the other thing, and
  // writes no key at all (above): two shapes of row the worker has to read as
  // the same video, which is what pins them both here.
  const landscape = await order(app, organizer.token, memory.id, { orientation: "landscape" });
  expect(landscape.statusCode).toBe(201);
  expect(landscape.json().params).toEqual({
    target_seconds: 60,
    music_tracks: [],
    orientation: "landscape",
  });

  // Somebody else's memory, one that never existed and an id that is not a
  // uuid: byte for byte the same answer (docs/auth.md, «404 один на всех»).
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

test("the order carries the story, the frames picked by hand and the music as a list", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const elsewhere = await createMemory(app, organizer.token);

  // Defaulted so the ids read as strings: an empty one would fail the schema
  // loudly on the first order, which is what «material wrote nothing» deserves.
  const [first = "", second = "", third = "", fourth = ""] = await material(
    memory.id,
    organizer.user.id,
    4,
  );
  const [unprobed] = await material(memory.id, organizer.user.id, 1, "processing");
  const [stray] = await material(elsewhere.id, organizer.user.id, 3);
  const ours = await track(memory.id, organizer.user.id);
  const theirs = await track(elsewhere.id, organizer.user.id);
  const unfinished = await track(memory.id, organizer.user.id, "pending_upload");

  // Everything doc-03 lets an organizer say about a video, said at once. The
  // story is trimmed — a text field comes off a phone with whatever whitespace
  // the keyboard left — and every other value goes through untouched.
  const asked = await order(app, organizer.token, memory.id, {
    story_text: "  Как мы ехали на дачу  ",
    include_media_ids: [first, second],
    exclude_media_ids: [third],
    music_tracks: [ours, "calm"],
    music_note: "  Свой трек первым, дальше спокойное  ",
    orientation: "portrait",
  });
  expect(asked.statusCode).toBe(201);
  const wanted = {
    target_seconds: 60,
    story_text: "Как мы ехали на дачу",
    include_media_ids: [first, second],
    exclude_media_ids: [third],
    music_tracks: [ours, "calm"],
    music_note: "Свой трек первым, дальше спокойное",
    orientation: "portrait",
  };
  expect(asked.json().params).toEqual(wanted);
  // And still there when the app reads the list — the worker takes it from the
  // same place.
  const listed = (await list(app, organizer.token, memory.id)).json();
  expect(listed.find((item: { id: string }) => item.id === asked.json().id)?.params).toEqual(
    wanted,
  );

  // The same id in capitals is the same frame: Postgres answers in lower case,
  // so what is written down is lower case whatever the client typed.
  const shouty = await order(app, organizer.token, memory.id, {
    include_media_ids: [first.toUpperCase()],
  });
  expect(shouty.statusCode).toBe(201);
  expect(shouty.json().params.include_media_ids).toEqual([first]);

  // And named twice in two spellings it is still one frame. The schema's
  // `uniqueItems` compares the strings as they arrived, so this is the one way
  // a duplicate gets past it — and the worker must not be handed the same id
  // twice by a client that shouted half of it.
  const twice = await order(app, organizer.token, memory.id, {
    include_media_ids: [first, first.toUpperCase()],
  });
  expect(twice.statusCode).toBe(201);
  expect(twice.json().params.include_media_ids).toEqual([first]);

  // One id sent unwrapped is a list of one: Fastify's ajv coerces a scalar into
  // the array the schema asks for, and the frame it names is honoured like any
  // other. Pinned because it is surprising, not because it is asked for.
  const single = await order(app, organizer.token, memory.id, { exclude_media_ids: fourth });
  expect(single.statusCode).toBe(201);
  expect(single.json().params.exclude_media_ids).toEqual([fourth]);

  // Every track of the shelf, in the order of the screen, all in one list: the
  // order they are listed in is the order they play in, so it is written down
  // exactly as it came — `night` and `road` came with the real library and were
  // refused here alone while this service still knew three.
  const shelf = ["bright", "warm", "calm", "night", "road"];
  const wholeShelf = await order(app, organizer.token, memory.id, { music_tracks: shelf });
  expect(wholeShelf.statusCode).toBe(201);
  expect(wholeShelf.json().params).toEqual({ target_seconds: 60, music_tracks: shelf });
  // Reversed it is a different order and not the same set: nothing here sorts.
  const reversed = await order(app, organizer.token, memory.id, {
    music_tracks: [...shelf].reverse(),
  });
  expect(reversed.json().params.music_tracks).toEqual([...shelf].reverse());
  // And still there when the app reads the list — the worker takes the music
  // from the same place.
  const shelfListed = (await list(app, organizer.token, memory.id)).json();
  expect(
    shelfListed.find((item: { id: string }) => item.id === wholeShelf.json().id)?.params,
  ).toEqual({ target_seconds: 60, music_tracks: shelf });

  // Empty, the field left out, and a wish that is nothing but spaces: the same
  // «без музыки», and the empty list is written down in all three (the worker
  // tells it from an order made before the field existed by nothing else).
  for (const payload of [{}, { music_tracks: [] }, { music_tracks: [], music_note: "   " }]) {
    const silent = await order(app, organizer.token, memory.id, payload);
    expect(silent.statusCode).toBe(201);
    expect(silent.json().params).toEqual({ target_seconds: 60, music_tracks: [] });
  }

  const before = (await montageRows(memory.id)).length;

  // A wish about the music with no music to wish about: refused by name rather
  // than written into a row the worker cannot honour.
  const orphanNote = await order(app, organizer.token, memory.id, {
    music_note: "погромче к финалу",
  });
  expect(orphanNote.statusCode).toBe(400);
  expect(orphanNote.json()).toEqual({ error: "music_note needs music_tracks" });

  // A frame in both lists is «обязательно и ни в коем случае».
  const contradiction = await order(app, organizer.token, memory.id, {
    include_media_ids: [first, second],
    exclude_media_ids: [second],
  });
  expect(contradiction.statusCode).toBe(400);
  expect(contradiction.json()).toEqual({
    error: "a media item cannot be both included and excluded",
    media_ids: [second],
  });

  // Named and not there: another memory's frame, one nobody has, and one still
  // being probed — all three by name, not dropped quietly.
  for (const [payload, media_ids] of [
    [{ include_media_ids: [stray] }, [stray]],
    [{ exclude_media_ids: [stray] }, [stray]],
    [{ include_media_ids: [fourth], exclude_media_ids: [unprobed] }, [unprobed]],
  ] as const) {
    const answer = await order(app, organizer.token, memory.id, payload);
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toEqual({ error: "no such ready media in this memory", media_ids });
  }

  // Enough in the memory, not enough in the order: four `ready` frames with two
  // of them crossed out is a video assembled from two, and that is the same
  // refusal as a memory holding two. The number in the answer is what the order
  // has left, not what the memory holds — «2 из нужных 3», not «4».
  const gutted = await order(app, organizer.token, memory.id, {
    exclude_media_ids: [first, second],
  });
  expect(gutted.statusCode).toBe(409);
  expect(gutted.json()).toEqual({
    error: "not enough material for a montage",
    ready_items: 2,
    need: 3,
  });

  // The same for a track: another memory's, one whose bytes never landed, one
  // nobody uploaded and a shelf id that is not on the shelf — every one of them
  // by name, in the list they were named in, and the good ones beside them do
  // not make the order pass.
  for (const [payload, music_tracks] of [
    [{ music_tracks: [theirs] }, [theirs]],
    [{ music_tracks: [unfinished] }, [unfinished]],
    [{ music_tracks: ["epic"] }, ["epic"]],
    [{ music_tracks: ["calm", theirs, "epic"] }, [theirs, "epic"]],
  ] as const) {
    const answer = await order(app, organizer.token, memory.id, payload);
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toEqual({ error: "no such music track", music_tracks });
  }

  // Refused by the schema, before a row exists: a story longer than anyone
  // writes, an id that is not one, the same id twice, the same track twice, a
  // wall of tracks and a note longer than a wish.
  for (const payload of [
    { story_text: "я".repeat(2001) },
    { include_media_ids: ["not-a-uuid"] },
    { exclude_media_ids: [first, first] },
    { music_tracks: ["calm", "calm"] },
    { music_tracks: Array.from({ length: 51 }, () => randomUUID()) },
    { music_tracks: ["calm"], music_note: "я".repeat(501) },
  ]) {
    expect((await order(app, organizer.token, memory.id, payload)).statusCode).toBe(400);
  }

  // Not one of those refusals wrote a montage.
  expect((await montageRows(memory.id)).length).toBe(before);

  // Said nothing, or said it empty — a client clearing a field sends it empty
  // rather than dropping it, and neither writes a key into `params`.
  const bare = await order(app, organizer.token, memory.id, {
    story_text: "   ",
    include_media_ids: [],
    exclude_media_ids: [],
  });
  expect(bare.statusCode).toBe(201);
  expect(bare.json().params).toEqual({ target_seconds: 60, music_tracks: [] });

  // A NUL and a lone surrogate are legal in a JSON string and impossible in
  // Postgres — the first in any text at all, the second in the `jsonb` this
  // order writes. Both come out of a paste and neither is anything a person
  // meant, so they are dropped and the story goes in: «internal» over a stray
  // byte in «расскажите про ролик» is the answer this field must never give.
  const nul = String.fromCharCode(0);
  const pasted = await order(app, organizer.token, memory.id, {
    story_text: `Как${nul} мы \ud800ехали`,
  });
  expect(pasted.statusCode).toBe(201);
  expect(pasted.json().params.story_text).toBe("Как мы ехали");
  // Nothing of the story but those two goes: emoji are whole code points and
  // survive, which is what «drop the unstorable» must not quietly mean «drop
  // what the keyboard makes».
  const emoji = await order(app, organizer.token, memory.id, {
    story_text: "Поехали \u{1F697} на дачу",
  });
  expect(emoji.statusCode).toBe(201);
  expect(emoji.json().params.story_text).toBe("Поехали \u{1F697} на дачу");
  // The same byte in a track is «нет такого трека», not a `500`: a key is
  // `music/<uuid>`, so one carrying a NUL names nothing whichever way it is
  // read.
  const nulKey = await order(app, organizer.token, memory.id, {
    music_tracks: [`music/${nul}`],
  });
  expect(nulKey.statusCode).toBe(400);
  expect(nulKey.json().error).toBe("no such music track");

  // A real key with a lone surrogate stitched onto it *becomes* the real key
  // once cleaned, and the lookup is done on the cleaned string — so this must
  // not write the dirty original into `params` and hand `jsonb` the exact byte
  // it was just proven to refuse. It must resolve to the track it was cleaned
  // into, and the note beside it is cleaned like the story.
  const dirty = await order(app, organizer.token, memory.id, {
    music_tracks: [`${ours}\ud800`],
    music_note: `гром${nul}че`,
  });
  expect(dirty.statusCode).toBe(201);
  expect(dirty.json().params.music_tracks).toEqual([ours]);
  expect(dirty.json().params.music_note).toBe("громче");

  await app.close();
});

test("the length a montage may be ordered at is cut from the memory's own material", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());

  // Three photos: two and a half seconds each, less half a second for each of
  // the two joins the worker crossfades — six and a half, floored to a whole
  // second. The floor of ten gives way to it — a band with nothing in it would
  // refuse every length there is — so the only length this memory can be asked
  // for is six, and «ничего не сказали» gets six rather than a refusal nobody
  // asked for.
  const thin = await createMemory(app, organizer.token);
  await material(thin.id, organizer.user.id, 3, "ready", "photo");
  expect((await order(app, organizer.token, thin.id, {})).json().params.target_seconds).toBe(6);
  const tooLong = await order(app, organizer.token, thin.id, { target_seconds: 7 });
  expect(tooLong.statusCode).toBe(400);
  expect(tooLong.json()).toEqual({
    error: "target_seconds out of range",
    min_seconds: 6,
    max_seconds: 6,
  });
  expect((await order(app, organizer.token, thin.id, { target_seconds: 6 })).statusCode).toBe(201);

  // Videos are worth their own length, photos two and a half seconds, and a
  // video the worker never measured is worth nothing — an unmeasured file must
  // not lengthen the ceiling. Two of thirty, one unmeasured and two photos:
  // sixty-five seconds less four joins, sixty-three, and the default sixty fits
  // inside it.
  const mixed = await createMemory(app, organizer.token);
  const [half = ""] = await material(mixed.id, organizer.user.id, 2, "ready", "video", 30);
  await material(mixed.id, organizer.user.id, 1, "ready", "video", null);
  await material(mixed.id, organizer.user.id, 2, "ready", "photo");
  expect((await order(app, organizer.token, mixed.id, {})).json().params.target_seconds).toBe(60);
  expect((await order(app, organizer.token, mixed.id, { target_seconds: 63 })).statusCode).toBe(
    201,
  );
  for (const [target_seconds, bounds] of [
    [64, { min_seconds: 10, max_seconds: 63 }],
    [9, { min_seconds: 10, max_seconds: 63 }],
  ] as const) {
    const refused = await order(app, organizer.token, mixed.id, { target_seconds });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "target_seconds out of range", ...bounds });
  }

  // A crossed-out frame takes its seconds with it, and its join: the video is
  // assembled out of what is left, so the ceiling is what is left too.
  const shortened = await order(app, organizer.token, mixed.id, {
    target_seconds: 40,
    exclude_media_ids: [half],
  });
  expect(shortened.statusCode).toBe(400);
  expect(shortened.json()).toEqual({
    error: "target_seconds out of range",
    min_seconds: 10,
    max_seconds: 33,
  });

  // And ten minutes however much material there is (doc-03): fifteen minutes of
  // video still buys a ten-minute ceiling.
  const long = await createMemory(app, organizer.token);
  await material(long.id, organizer.user.id, 3, "ready", "video", 300);
  expect((await order(app, organizer.token, long.id, { target_seconds: 600 })).statusCode).toBe(
    201,
  );
  const past = await order(app, organizer.token, long.id, { target_seconds: 601 });
  expect(past.statusCode).toBe(400);
  expect(past.json()).toEqual({
    error: "target_seconds out of range",
    min_seconds: 10,
    max_seconds: 600,
  });

  await app.close();
});

test("the ceiling is the video the worker assembles out of everything there is", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());

  // The worker's own material beside the worker's own arithmetic. Clips of 12,
  // 30 and 7 seconds and three photos are what projects/montage orders «всё,
  // что есть» out of (test_selection.py,
  // `test_an_order_for_everything_there_is_takes_every_piece_whole`): every
  // piece held whole, a photo for `selection.PHOTO_SECONDS` (2.5), laid end to
  // end by `assembly.length_of` less `assembly.CROSSFADE_SECONDS` (0.5) a join.
  // 12 + 30 + 7 + 3 × 2.5 − 5 × 0.5 = 54 seconds: the most that may be ordered
  // is exactly what that order gets. Either number moved on that side moves
  // `photoSeconds` or `crossfadeSeconds` in material.ts, and this with it.
  const memory = await createMemory(app, organizer.token);
  for (const seconds of [12, 30, 7]) {
    await material(memory.id, organizer.user.id, 1, "ready", "video", seconds);
  }
  await material(memory.id, organizer.user.id, 3, "ready", "photo");
  const everything = 54;

  const summary = await preview(app, organizer.token, memory.id, {});
  expect(summary.json()).toMatchObject({ min_seconds: 10, max_seconds: everything });
  const whole = await alike(app, organizer.token, memory.id, { target_seconds: everything });
  expect(whole.statusCode).toBe(201);
  const past = await alike(app, organizer.token, memory.id, { target_seconds: everything + 1 });
  expect(past.json()).toEqual({
    error: "target_seconds out of range",
    min_seconds: 10,
    max_seconds: everything,
  });

  // Forty photos: a hundred seconds of stills, less thirty-nine joins. The
  // worker's video of all forty runs 80.5, so eighty is the most that may be
  // asked for — not the hundred the stills add up to.
  const stills = await createMemory(app, organizer.token);
  await material(stills.id, organizer.user.id, 40, "ready", "photo");
  expect((await preview(app, organizer.token, stills.id, {})).json()).toMatchObject({
    min_seconds: 10,
    max_seconds: 80,
  });

  await app.close();
});

test("what the отсев turned down is out of the ceiling and the floor, unless it is taken back", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const token = organizer.token;
  const out = (min_seconds: number, max_seconds: number) => ({
    error: "target_seconds out of range",
    min_seconds,
    max_seconds,
  });

  // Two thirty-second clips and four photos: 70 seconds less five joins, 67 —
  // and 67 still while the отсев has not looked, or has looked and kept.
  const memory = await createMemory(app, token);
  const [blurred = ""] = await material(memory.id, organizer.user.id, 2, "ready", "video", 30);
  const [dark = "", broken = "", kept = ""] = await material(
    memory.id,
    organizer.user.id,
    4,
    "ready",
    "photo",
  );
  const everything = { photos: 4, videos: 2, min_seconds: 10, max_seconds: 67 };
  expect((await preview(app, token, memory.id, {})).json()).toMatchObject(everything);
  await screened(kept, null);
  expect((await preview(app, token, memory.id, {})).json()).toMatchObject(everything);

  // A blurred clip, a dark photo and one nobody can read are what the worker
  // leaves out: their 35 seconds and three joins go — a clip and two photos
  // are 35 less two joins, 34. The summary and the order say so alike.
  await screened(blurred, "blur");
  await screened(dark, "exposure");
  await screened(broken, "unreadable");
  expect((await preview(app, token, memory.id, {})).json()).toMatchObject({
    photos: 2,
    videos: 1,
    min_seconds: 10,
    max_seconds: 34,
  });
  expect((await alike(app, token, memory.id, { target_seconds: 34 })).statusCode).toBe(201);
  expect((await alike(app, token, memory.id, { target_seconds: 35 })).json()).toEqual(out(10, 34));

  // Crossed out by name as well, the way the app sends them, it is the same
  // material: they were not counted to begin with.
  const named = { exclude_media_ids: [blurred, dark, broken] };
  expect((await preview(app, token, memory.id, named)).json()).toEqual(
    (await preview(app, token, memory.id, {})).json(),
  );

  // Taken back, the clip counts again, seconds and join: 65 less three joins.
  // An unreadable frame does not, taken back or not — the worker has no frame
  // of it to put in.
  const back = { include_media_ids: [blurred, broken] };
  expect((await preview(app, token, memory.id, back)).json()).toMatchObject({
    videos: 2,
    photos: 2,
    max_seconds: 63,
  });
  expect((await alike(app, token, memory.id, { ...back, target_seconds: 63 })).statusCode).toBe(
    201,
  );
  expect((await alike(app, token, memory.id, { ...back, target_seconds: 64 })).json()).toEqual(
    out(10, 63),
  );

  // The floor of three is held against the same frames: three photos with one
  // turned down are two, which is too little, until it is taken back.
  const thin = await createMemory(app, token);
  const [spoiled = ""] = await material(thin.id, organizer.user.id, 3, "ready", "photo");
  await screened(spoiled, "blur");
  expect((await alike(app, token, thin.id, {})).json()).toEqual({
    error: "not enough material for a montage",
    ready_items: 2,
    need: 3,
  });
  const taken = await alike(app, token, thin.id, { include_media_ids: [spoiled] });
  expect(taken.statusCode).toBe(201);
  expect(taken.json().params.target_seconds).toBe(6);

  await app.close();
});

test("the default length is held inside the memory's band, not merely obeyed", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, 3, "ready", "video", 300);

  const previous = process.env.MONTAGE_TARGET_SECONDS;
  try {
    // Past the ceiling — a typo in the environment, not an intent for a video
    // no client could have asked for, since the same number would be refused
    // to anyone who named it.
    process.env.MONTAGE_TARGET_SECONDS = "900";
    const over = await order(app, organizer.token, memory.id, {});
    expect(over.statusCode).toBe(201);
    expect(over.json().params.target_seconds).toBe(600);

    // Under the floor, the same way.
    process.env.MONTAGE_TARGET_SECONDS = "5";
    const under = await order(app, organizer.token, memory.id, {});
    expect(under.statusCode).toBe(201);
    expect(under.json().params.target_seconds).toBe(10);
  } finally {
    if (previous === undefined) delete process.env.MONTAGE_TARGET_SECONDS;
    else process.env.MONTAGE_TARGET_SECONDS = previous;
  }

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

test("a montage still being assembled carries its five stages in the list", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);

  await material(memory.id, organizer.user.id, 3);
  // Four videos in one memory and one list: the stages of all of them are read
  // at once, and each card gets its own — not the first one's, and not a
  // neighbour's.
  const done = (await order(app, organizer.token, memory.id, {})).json();
  const broken = (await order(app, organizer.token, memory.id, {})).json();
  const live = (await order(app, organizer.token, memory.id, {})).json();
  const fresh = (await order(app, organizer.token, memory.id, {})).json();

  // Assembled, and its journal stays beside it — «как собирался» is opened from
  // the journal route long after. The card on the feed still shows no scale.
  await assembled(done.id);
  for (const key of ["screening", "understanding", "directing", "rhythm", "assembly"]) {
    await stage(done.id, key, "done");
  }

  // Fell over on the third stage, which is the one the card paints red.
  await stage(broken.id, "screening", "done");
  await stage(broken.id, "understanding", "done");
  await stage(broken.id, "directing", "failed");
  await fell(broken.id);

  // At it right now: two behind, one running — «2 из 5» on the feed. The last
  // two stages have no row yet; the worker writes each as it reaches it.
  await running(live.id);
  await stage(live.id, "screening", "done");
  await stage(live.id, "understanding", "done");
  await stage(live.id, "directing", "running");

  // `fresh` is left as the order route left it: queued, and not picked up.

  const seen = await list(app, viewer.token, memory.id);
  expect(seen.statusCode).toBe(200);
  const items = seen.json() as {
    id: string;
    status: string;
    video_url: string | null;
    stages: { stage: string; state: string }[] | null;
  }[];
  const byId = new Map(items.map((item) => [item.id, item]));

  // Five, in the order of the pipeline and not in the order the worker wrote
  // them; a stage with no row yet is `pending`, so the scale is five bars from
  // the very first second the worker is at it.
  expect(byId.get(live.id)?.stages).toEqual([
    { stage: "screening", state: "done" },
    { stage: "understanding", state: "done" },
    { stage: "directing", state: "running" },
    { stage: "rhythm", state: "pending" },
    { stage: "assembly", state: "pending" },
  ]);
  expect(byId.get(broken.id)?.stages).toEqual([
    { stage: "screening", state: "done" },
    { stage: "understanding", state: "done" },
    { stage: "directing", state: "failed" },
    { stage: "rhythm", state: "pending" },
    { stage: "assembly", state: "pending" },
  ]);
  // Ready — nothing to draw, even with all five rows standing behind it. Not
  // started — nothing to draw either, and five empty bars would claim it is
  // under way.
  expect(byId.get(done.id)?.stages).toBeNull();
  expect(byId.get(fresh.id)?.stages).toBeNull();

  // Every other field, and their order, are exactly what they were: the stages
  // arrive beside them, not instead of anything.
  expect(Object.keys(byId.get(live.id) ?? {})).toEqual([
    "id",
    "memory_id",
    "ordered_by",
    "status",
    "duration_seconds",
    "params",
    "error_text",
    "created_at",
    "updated_at",
    "video_url",
    "poster_url",
    "stages",
  ]);
  expect(byId.get(done.id)).toMatchObject({ status: "ready", duration_seconds: 58.5 });
  expect(byId.get(done.id)?.video_url).toContain(`montages/${done.id}.mp4`);
  expect(byId.get(broken.id)).toMatchObject({ error_text: "ffmpeg said no" });

  // The list is the shelf the videos stand on, not «я смотрю сборку»: reading
  // it marks nobody as watching. That is the journal route's own doing.
  for (const id of [live.id, broken.id, done.id, fresh.id]) {
    expect(await watching(id)).toBe(0);
  }

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

test("repeating a montage that fell starts its journal from a clean sheet", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, 3);

  const montage = (await order(app, organizer.token, memory.id, {})).json();
  // A neighbour that also fell and also has a journal: only the montage being
  // repeated is wiped, and this is what says so.
  const neighbour = (await order(app, organizer.token, memory.id, {})).json();

  // Marked as watching the way the app marks anyone — by reading the journal of
  // a montage that is still queued. Nobody sends «я смотрю».
  expect((await journal(app, organizer.token, memory.id, montage.id)).statusCode).toBe(200);
  expect(await watching(montage.id)).toBe(1);

  // The worker's half of the failed attempt, on both.
  for (const id of [montage.id, neighbour.id]) {
    await stage(id, "screening", "done");
    await stage(id, "understanding", "failed");
    await said(id, "screening", "212 из 214 годятся");
    await said(id, "understanding", "не разобрал, кто в кадре");
    await fell(id);
  }

  const again = await retry(app, organizer.token, memory.id, montage.id);
  expect(again.statusCode).toBe(200);
  expect(again.json()).toMatchObject({ id: montage.id, status: "queued", error_text: null });

  // Gone with the status, in the same transaction — and the watchers are not:
  // read before the journal route, which would mark the organizer again itself.
  expect(await journalOf(montage.id)).toEqual({ lines: 0, stages: 0 });
  expect(await watching(montage.id)).toBe(1);
  // The neighbour's failed attempt is untouched by the button on this one.
  expect(await journalOf(neighbour.id)).toEqual({ lines: 2, stages: 2 });

  // The two screens that told the old story tell none: the journal of a queued
  // montage is empty, and its card on the feed draws no scale at all — «не
  // взяли ещё», which is what it is.
  const told = await journal(app, organizer.token, memory.id, montage.id);
  expect(told.statusCode).toBe(200);
  expect(told.json()).toMatchObject({
    montage: { id: montage.id, status: "queued" },
    stages: [],
    entries: [],
    has_more: false,
  });
  expect((told.json().viewers as { id: string }[]).map((v) => v.id)).toEqual([organizer.user.id]);

  const items = (await list(app, organizer.token, memory.id)).json() as {
    id: string;
    stages: { stage: string; state: string }[] | null;
  }[];
  const byId = new Map(items.map((item) => [item.id, item]));
  expect(byId.get(montage.id)?.stages).toBeNull();
  expect(byId.get(neighbour.id)?.stages).toEqual([
    { stage: "screening", state: "done" },
    { stage: "understanding", state: "failed" },
    { stage: "directing", state: "pending" },
    { stage: "rhythm", state: "pending" },
    { stage: "assembly", state: "pending" },
  ]);

  // The worker takes it up and starts writing the second attempt. «Повторить»
  // over that is the old `409`, and it wipes nothing — a stray tap on the
  // button must not erase a montage that is being assembled right now.
  await running(montage.id);
  await stage(montage.id, "screening", "running");
  await said(montage.id, "screening", "беру всё заново");
  const refused = await retry(app, organizer.token, memory.id, montage.id);
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toEqual({ error: "montage has not failed", status: "processing" });
  expect(await journalOf(montage.id)).toEqual({ lines: 1, stages: 1 });

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

test("the summary counts what would go in and refuses whatever the order refuses", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());

  // Three photos of the organizer's and two minute-long videos of the
  // contributor's: five frames from two people, 7,5 + 120 seconds of material
  // behind them less four joins. One more of the organizer's is still being
  // probed — it is in no summary, exactly as it is in no montage.
  const [photo = ""] = await material(memory.id, organizer.user.id, 3, "ready", "photo");
  const [clip = "", clipToo = ""] = await material(
    memory.id,
    contributor.user.id,
    2,
    "ready",
    "video",
    60,
  );
  await material(memory.id, organizer.user.id, 1, "processing");

  // What the screen is drawn from: how much goes in, from how many people, the
  // band the length lives in, the length the order would write, the shape and
  // the wait («168 фото · 46 видео, от 5 человек», «Соберём примерно за 15
  // минут» — `design/screens/MontageSummary.html`).
  const summary = await preview(app, organizer.token, memory.id, {});
  expect(summary.statusCode).toBe(200);
  expect(summary.json()).toEqual({
    photos: 3,
    videos: 2,
    people: 2,
    min_seconds: 10,
    max_seconds: 125,
    target_seconds: 60,
    orientation: "landscape",
    estimate_minutes: 2,
  });

  // The other two shapes of «без пожеланий» the order takes are the same
  // summary: no body at all, and a literal `null`.
  for (const shown of [
    await preview(app, organizer.token, memory.id),
    await app.inject({
      method: "POST",
      url: `/memories/${memory.id}/montages/preview`,
      headers: { authorization: `Bearer ${organizer.token}`, "content-type": "application/json" },
      payload: "null",
    }),
  ]) {
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual(summary.json());
  }

  // Asked for outright, the length and the shape come back as asked — and the
  // wait grows with the video, not with the pile of frames alone.
  const asked = await preview(app, organizer.token, memory.id, {
    target_seconds: 120,
    orientation: "portrait",
    story_text: "Как мы ехали на дачу",
  });
  expect(asked.json()).toMatchObject({
    target_seconds: 120,
    orientation: "portrait",
    estimate_minutes: 4,
  });

  // A crossed-out frame leaves everything else standing: one of the
  // contributor's videos gone is one video fewer and a lower ceiling, and the
  // contributor is still among the people because their other frame stays.
  const withoutOne = await preview(app, organizer.token, memory.id, { exclude_media_ids: [clip] });
  expect(withoutOne.json()).toEqual({
    photos: 3,
    videos: 1,
    people: 2,
    min_seconds: 10,
    max_seconds: 66,
    target_seconds: 60,
    orientation: "landscape",
    estimate_minutes: 2,
  });

  // Both of them gone and it is three photos from one person: six seconds of
  // video, a band collapsed onto its ceiling, and a wait that never falls
  // under a minute however little there is to do.
  const photosOnly = await preview(app, organizer.token, memory.id, {
    exclude_media_ids: [clip, clipToo],
  });
  expect(photosOnly.json()).toEqual({
    photos: 3,
    videos: 0,
    people: 1,
    min_seconds: 6,
    max_seconds: 6,
    target_seconds: 6,
    orientation: "landscape",
    estimate_minutes: 1,
  });

  // Every refusal the order gives, given here first and word for word — a
  // summary that agrees to what «Начать монтаж» will turn down is worse than
  // no summary. Both asked with the same body, and both answers compared, so
  // the two cannot drift apart: a frame in both lists, a frame that is not
  // here, one still being probed, a length outside the band, a track off no
  // shelf, a wish about music with no music, a shape that is not a shape, and
  // an order left with two frames out of five.
  for (const payload of [
    { include_media_ids: [photo], exclude_media_ids: [photo] },
    { include_media_ids: [randomUUID()] },
    { target_seconds: 9 },
    { target_seconds: 126 },
    { music_tracks: ["epic"] },
    { music_note: "погромче к финалу" },
    { orientation: "square" },
    { exclude_media_ids: [clip, clipToo, photo] },
  ]) {
    const shown = await preview(app, organizer.token, memory.id, payload);
    const placed = await order(app, organizer.token, memory.id, payload);
    expect(shown.statusCode).not.toBe(200);
    expect(shown.statusCode).toBe(placed.statusCode);
    expect(shown.json()).toEqual(placed.json());
  }

  // Nobody but the organizer asks what would be assembled, and nobody outside
  // the memory learns it exists — the same answers the order gives, including
  // the one `404` for a stranger's memory, one nobody has and an id that is
  // not one.
  for (const token of [contributor.token, viewer.token]) {
    const refused = await preview(app, token, memory.id, {});
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }
  for (const id of [memory.id, randomUUID(), "not-a-uuid"]) {
    const answer = await preview(app, stranger.token, id, {});
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  const anonymous = await app.inject({
    method: "POST",
    url: `/memories/${memory.id}/montages/preview`,
    payload: {},
  });
  expect(anonymous.statusCode).toBe(401);

  // And after all of that — the summaries and every refusal both routes gave —
  // nothing has been written: no montage, no job for one, and the counters
  // that a price would one day be charged on still at nothing.
  expect(await montageRows(memory.id)).toEqual([]);
  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 0, user: 0 });

  // Посмотрели итог и нажали «Начать монтаж»: the video ordered on the body
  // the summary was shown for is the video the summary described.
  const placed = await order(app, organizer.token, memory.id, {
    target_seconds: 120,
    orientation: "portrait",
  });
  expect(placed.statusCode).toBe(201);
  expect(placed.json().params).toMatchObject({ target_seconds: 120, orientation: "portrait" });
  expect(await jobsFor(placed.json().id)).toEqual([{ type: "montage", status: "queued" }]);

  await app.close();
});

/**
 * The summary and the order asked the same thing: one code, one body — and when
 * it goes through, the same length. The order is placed for real, so a body
 * that passes leaves a montage behind; the tests count on nothing else.
 */
async function alike(app: App, token: string, memoryId: string, payload: object) {
  const shown = await preview(app, token, memoryId, payload);
  const placed = await order(app, token, memoryId, payload);
  const context = JSON.stringify(payload);
  if (placed.statusCode === 201) {
    expect(shown.statusCode, context).toBe(200);
    expect(shown.json().target_seconds, context).toBe(placed.json().params.target_seconds);
  } else {
    expect(shown.statusCode, context).toBe(placed.statusCode);
    expect(shown.json(), context).toEqual(placed.json());
  }
  return placed;
}

test("the summary and the order agree on every edge of the band, whatever is left in the memory", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const token = organizer.token;
  const out = (min_seconds: number, max_seconds: number) => ({
    error: "target_seconds out of range",
    min_seconds,
    max_seconds,
  });
  const scarce = (ready_items: number) => ({
    error: "not enough material for a montage",
    ready_items,
    need: 3,
  });
  // Every row: what is asked, what both routes answer, and — when the answer is
  // a length — the one the order wrote down.
  const check = async (
    memoryId: string,
    payload: object,
    status: number,
    expected?: { body?: object; target_seconds?: number },
  ) => {
    const placed = await alike(app, token, memoryId, payload);
    expect(placed.statusCode, JSON.stringify(payload)).toBe(status);
    if (expected?.body) expect(placed.json()).toEqual(expected.body);
    if (expected?.target_seconds !== undefined) {
      expect(placed.json().params.target_seconds).toBe(expected.target_seconds);
    }
  };

  // Two thirty-second videos, one nobody measured, two photos: 65 seconds less
  // four joins, 63.
  const mixed = await createMemory(app, token);
  const [long1 = "", long2 = ""] = await material(
    mixed.id,
    organizer.user.id,
    2,
    "ready",
    "video",
    30,
  );
  const [blind = ""] = await material(mixed.id, organizer.user.id, 1, "ready", "video", null);
  const [photo1 = "", photo2 = ""] = await material(
    mixed.id,
    organizer.user.id,
    2,
    "ready",
    "photo",
  );
  await check(mixed.id, {}, 201, { target_seconds: 60 });
  await check(mixed.id, { target_seconds: 63 }, 201, { target_seconds: 63 });
  await check(mixed.id, { target_seconds: 10 }, 201, { target_seconds: 10 });
  for (const target_seconds of [64, 9, 0, -1]) {
    await check(mixed.id, { target_seconds }, 400, { body: out(10, 63) });
  }
  // A crossed-out frame takes its seconds and its join off the ceiling, on both
  // routes alike: 35 seconds less three joins.
  await check(mixed.id, { exclude_media_ids: [long1], target_seconds: 33 }, 201);
  await check(mixed.id, { exclude_media_ids: [long1], target_seconds: 34 }, 400, {
    body: out(10, 33),
  });
  // Both thirty-second videos out: what is left is a photo pair and a video with
  // no length — five seconds less two joins, a band that has collapsed onto its
  // ceiling, and the default length squeezed into it.
  const stripped = { exclude_media_ids: [long1, long2] };
  await check(mixed.id, stripped, 201, { target_seconds: 4 });
  await check(mixed.id, { ...stripped, target_seconds: 4 }, 201);
  await check(mixed.id, { ...stripped, target_seconds: 5 }, 400, { body: out(4, 4) });
  await check(mixed.id, { ...stripped, target_seconds: 3 }, 400, { body: out(4, 4) });
  // Two left is too little material, and it is two whatever was crossed out.
  await check(mixed.id, { exclude_media_ids: [long1, long2, photo1] }, 409, { body: scarce(2) });
  await check(mixed.id, { exclude_media_ids: [long1, long2, blind] }, 409, { body: scarce(2) });
  await check(mixed.id, { exclude_media_ids: [long1, long2, blind, photo1, photo2] }, 409, {
    body: scarce(0),
  });

  // Only photos: 7,5 seconds less two joins, floored — six is the whole band.
  const photos = await createMemory(app, token);
  await material(photos.id, organizer.user.id, 3, "ready", "photo");
  await check(photos.id, {}, 201, { target_seconds: 6 });
  await check(photos.id, { target_seconds: 6 }, 201);
  await check(photos.id, { target_seconds: 5 }, 400, { body: out(6, 6) });
  await check(photos.id, { target_seconds: 7 }, 400, { body: out(6, 6) });

  // Nothing but videos nobody measured: a ceiling of nothing, which their
  // joins do not take below zero — refused as too little material, with the
  // count of what is there, by both routes.
  const unmeasured = await createMemory(app, token);
  await material(unmeasured.id, organizer.user.id, 3, "ready", "video", null);
  await check(unmeasured.id, {}, 409, { body: scarce(3) });
  await check(unmeasured.id, { target_seconds: 60 }, 409, { body: scarce(3) });
  // One photo beside them is two and a half seconds less three joins: the
  // ceiling of one, and taking the photo out puts the memory back to nothing.
  const [lone = ""] = await material(unmeasured.id, organizer.user.id, 1, "ready", "photo");
  await check(unmeasured.id, {}, 201, { target_seconds: 1 });
  await check(unmeasured.id, { target_seconds: 2 }, 400, { body: out(1, 1) });
  await check(unmeasured.id, { exclude_media_ids: [lone] }, 409, { body: scarce(3) });

  // The ceiling is the whole seconds of what the worker assembles, and ten
  // minutes at the most: 599,9 less two joins is 598.
  const fractional = await createMemory(app, token);
  await material(fractional.id, organizer.user.id, 1, "ready", "video", 199.9);
  await material(fractional.id, organizer.user.id, 2, "ready", "video", 200);
  await check(fractional.id, { target_seconds: 598 }, 201);
  await check(fractional.id, { target_seconds: 599 }, 400, { body: out(10, 598) });
  const long = await createMemory(app, token);
  await material(long.id, organizer.user.id, 3, "ready", "video", 300);
  await check(long.id, { target_seconds: 600 }, 201);
  await check(long.id, { target_seconds: 601 }, 400, { body: out(10, 600) });
  await check(long.id, {}, 201, { target_seconds: 60 });
  // Ten minutes to the second once the joins are paid: 601 less two of them.
  const exact = await createMemory(app, token);
  await material(exact.id, organizer.user.id, 2, "ready", "video", 200);
  await material(exact.id, organizer.user.id, 1, "ready", "video", 201);
  await check(exact.id, { target_seconds: 600 }, 201);
  await check(exact.id, { target_seconds: 601 }, 400, { body: out(10, 600) });

  await app.close();
});

test("a montage ordered before the music became a list is still listed and can still be repeated", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, 3);
  const ownKey = await track(memory.id, organizer.user.id);

  // As the api wrote them before `music_tracks`: one track by id or by key, no
  // list and no note. Nothing writes these any more, and no order may ask for
  // them — but the videos ordered with them are still on the shelf.
  const placeOld = async (params: Record<string, string | number>, status: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into montages (memory_id, ordered_by, params, status, error_text)
      values (
        ${memory.id}, ${organizer.user.id}, ${sql.json(params)}, ${status},
        ${status === "failed" ? "ffmpeg said no" : null}
      )
      returning id
    `;
    return row?.id ?? "";
  };
  const byId = { target_seconds: 60, music_track_id: "warm" };
  const byKey = { target_seconds: 90, music_track_key: ownKey, orientation: "portrait" };
  const oldFailedById = await placeOld(byId, "failed");
  const oldFailedByKey = await placeOld(byKey, "failed");
  const oldReady = await placeOld(byId, "processing");
  await assembled(oldReady);

  const paramsOf = async () =>
    new Map(
      (
        (await list(app, organizer.token, memory.id)).json() as { id: string; params: object }[]
      ).map((item) => [item.id, item.params]),
    );
  let listed = await paramsOf();
  expect(listed.get(oldFailedById)).toEqual(byId);
  expect(listed.get(oldFailedByKey)).toEqual(byKey);
  expect(listed.get(oldReady)).toEqual(byId);

  // The material is gone since — an order for this memory now is a refusal, and
  // repeating a video that fell is not an order: it goes back to the worker as
  // it was, without being weighed again.
  await sql`delete from media_items where memory_id = ${memory.id}`;
  expect((await order(app, organizer.token, memory.id, {})).statusCode).toBe(409);

  for (const id of [oldFailedById, oldFailedByKey]) {
    const again = await retry(app, organizer.token, memory.id, id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id, status: "queued", error_text: null });
    expect(await jobsFor(id)).toEqual([{ type: "montage", status: "queued" }]);
  }
  listed = await paramsOf();
  expect(listed.get(oldFailedById)).toEqual(byId);
  expect(listed.get(oldFailedByKey)).toEqual(byKey);
  // Nobody ordered anything: the counters stay where they were.
  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 0, user: 0 });

  await app.close();
});

test("the music is a list of any tracks, the organizer's and the shelf's, and both routes refuse the same bad ones", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const token = organizer.token;
  const memory = await createMemory(app, token);
  const elsewhere = await createMemory(app, token);
  await material(memory.id, organizer.user.id, 3);
  const own1 = await track(memory.id, organizer.user.id);
  const own2 = await track(memory.id, organizer.user.id);
  const foreign = await track(elsewhere.id, organizer.user.id);
  const asked = async (payload: object) => alike(app, token, memory.id, payload);

  // Two of their own and two off the shelf, interleaved: written down in the
  // order they were named, not grouped by where they come from.
  const mixed = [own2, "road", own1, "bright"];
  const interleaved = await asked({ music_tracks: mixed, music_note: "по кругу" });
  expect(interleaved.statusCode).toBe(201);
  expect(interleaved.json().params).toMatchObject({ music_tracks: mixed, music_note: "по кругу" });

  // As many as an order may carry, all their own.
  const many = Array.from({ length: 50 }, () => `music/${randomUUID()}`);
  await sql`
    insert into music_uploads ${sql(
      many.map((object_key) => ({
        memory_id: memory.id,
        uploaded_by: organizer.user.id,
        status: "ready",
        object_key,
        size_bytes: 4096,
      })),
    )}
  `;
  const wall = await asked({ music_tracks: many });
  expect(wall.statusCode).toBe(201);
  expect(wall.json().params.music_tracks).toEqual(many);

  // A track that is not there is the same refusal whoever it belonged to: never
  // uploaded, another memory's, or a shelf id spelt the wrong way round.
  const ghost = `music/${randomUUID()}`;
  for (const named of [ghost, foreign, "Calm", "x".repeat(200)]) {
    const refused = await asked({ music_tracks: [named] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "no such music track", music_tracks: [named] });
  }

  // Too long a string, a track named twice and the two old fields fail the
  // schema — by name, with the field in the message, and the same on both routes.
  for (const [payload, field] of [
    [{ music_tracks: ["x".repeat(201)] }, "music_tracks"],
    [{ music_tracks: [own1, own1] }, "music_tracks"],
    [{ music_track_id: "calm" }, "music_track_id"],
    [{ music_track_key: own1 }, "music_track_key"],
    [{ music_tracks: ["calm"], music_note: "я".repeat(501) }, "music_note"],
  ] as const) {
    const refused = await asked(payload);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain(field);
  }

  // A wish about music needs music, and a list that only *looks* filled — an
  // empty name — has none: it is the same «без музыки» when alone and gives the
  // wish nothing to be about.
  const orphan = { error: "music_note needs music_tracks" };
  for (const payload of [
    { music_note: "погромче" },
    { music_tracks: [""], music_note: "погромче" },
  ]) {
    const refused = await asked(payload);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual(orphan);
  }
  const blank = await asked({ music_tracks: [""] });
  expect(blank.statusCode).toBe(201);
  expect(blank.json().params.music_tracks).toEqual([]);
  // The longest wish there is.
  const longest = await asked({ music_tracks: ["calm"], music_note: "я".repeat(500) });
  expect(longest.statusCode).toBe(201);
  expect(longest.json().params.music_note).toHaveLength(500);

  await app.close();
});
