import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, signIn } from "../auth/testing.ts";
import { sql } from "../db.ts";
import {
  alike,
  counters,
  jobsFor,
  list,
  material,
  montageRows,
  order,
  preview,
  screened,
  track,
  underTag,
} from "./testing.ts";

/**
 * «Смонтируй ролик» — сам заказ: кто его делает, из чего, что записывается в
 * `params` и чем отвечают на то, чего это воспоминание не тянет (`order.ts`).
 */

const { email, createMemory, member, cleanup } = underTag("task53order");

afterAll(cleanup);

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

  // Thrown out with no reason written beside it. The worker fills the two
  // columns together, but nothing in the database makes it (migration 060
  // declines a CHECK on purpose, because the vocabulary is the worker's), and
  // a `<>` against the empty one answers neither yes nor no — which would
  // quietly drop a frame the organizer asked for by name.
  await sql`
    update media_items set screening_rejected = true, screening_reason = null
    where id = ${dark}
  `;
  expect(
    (await preview(app, token, memory.id, { include_media_ids: [dark] })).json(),
  ).toMatchObject({ photos: 3 });

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
