import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, signIn } from "../auth/testing.ts";
import { sql } from "../db.ts";
import {
  assembled,
  counters,
  fell,
  jobsFor,
  journal,
  journalOf,
  layoutOf,
  list,
  markWatched,
  material,
  montageRows,
  order,
  removeMontage,
  rename,
  retry,
  running,
  said,
  speak,
  stage,
  track,
  underTag,
  watchesOf,
  watching,
} from "./testing.ts";

/**
 * Список роликов и «Повторить»: что видит участник на полке и что делает с
 * упавшей сборкой организатор (`montages.ts`).
 */

const { email, createMemory, member, cleanup } = underTag("task53");

afterAll(cleanup);

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
  for (const key of ["prep", "analysis", "directing", "music", "assembly"]) {
    await stage(done.id, key, "done");
  }

  // Fell over on the third stage, which is the one the card paints red.
  await stage(broken.id, "prep", "done");
  await stage(broken.id, "analysis", "done");
  await stage(broken.id, "directing", "failed");
  await fell(broken.id);

  // At it right now: two behind, one running — «2 из 5» on the feed. The last
  // two stages have no row yet; the worker writes each as it reaches it.
  await running(live.id);
  await stage(live.id, "prep", "done");
  await stage(live.id, "analysis", "done");
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
    { stage: "prep", state: "done" },
    { stage: "analysis", state: "done" },
    { stage: "directing", state: "running" },
    { stage: "music", state: "pending" },
    { stage: "assembly", state: "pending" },
  ]);
  expect(byId.get(broken.id)?.stages).toEqual([
    { stage: "prep", state: "done" },
    { stage: "analysis", state: "done" },
    { stage: "directing", state: "failed" },
    { stage: "music", state: "pending" },
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
    "name",
    "template",
    "size_bytes",
    "photos",
    "videos",
    "video_url",
    "poster_url",
    "stages",
    "queue",
    "watched_by",
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

test("a queued montage says what was ordered, how many montages are ahead of it and how long the wait is", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, 2, "ready", "photo");
  await material(memory.id, organizer.user.id, 3);

  // What the order counted is on the row from the start — the numbers the
  // summary showed — and the 60 seconds nobody asked for are its length.
  const building = (await order(app, organizer.token, memory.id, {})).json();
  expect(building).toMatchObject({ photos: 2, videos: 3, params: { target_seconds: 60 } });
  const next = (await order(app, organizer.token, memory.id, {})).json();
  const last = (await order(app, organizer.token, memory.id, {})).json();
  const done = (await order(app, organizer.token, memory.id, {})).json();
  await assembled(done.id);

  // The worker is at the first one, and its journal says what is left: 3 min.
  await running(building.id);
  await sql`update jobs set status = 'running' where type = 'montage' and ref = ${building.id}`;
  for (const [key, state, eta] of [
    ["prep", "done", 0],
    ["analysis", "running", 60],
    ["directing", "pending", 30],
    ["music", "pending", null],
    ["assembly", "pending", 90],
  ] as const) {
    await sql`
      insert into montage_stages (montage_id, stage, state, eta_seconds)
      values (${building.id}, ${key}, ${state}, ${eta})
    `;
  }
  // The other two wait at the very front of the queue — ahead of whatever the
  // test files beside this one have queued since — and `next` was repeated: it
  // has a second job, which is still one montage ahead of `last`, not two.
  await sql`update jobs set run_after = '2000-01-01' where type = 'montage' and ref = ${next.id}`;
  await sql`update jobs set run_after = '2000-01-02' where type = 'montage' and ref = ${last.id}`;
  await sql`insert into jobs (type, ref, run_after) values ('montage', ${next.id}, '2000-01-03')`;

  const items = (await list(app, organizer.token, memory.id)).json() as {
    id: string;
    queue: { ahead: number; starts_in_minutes: number; estimate_minutes: number | null } | null;
  }[];
  const queueOf = (id: string) => items.find((item) => item.id === id)?.queue;
  // Five frames on a minute is 5 × 3 s + 60 × 1.5 s = 105 s — «около 2 минут»,
  // the summary's own guess (`estimateMinutes`).
  expect(queueOf(next.id)).toEqual({ ahead: 1, starts_in_minutes: 3, estimate_minutes: 2 });
  // Behind the running one's 180 s and `next`'s 105 s: 285 s, up to 5 minutes.
  expect(queueOf(last.id)).toEqual({ ahead: 2, starts_in_minutes: 5, estimate_minutes: 2 });
  // Not waiting, nothing to say.
  expect(queueOf(building.id)).toBeNull();
  expect(queueOf(done.id)).toBeNull();

  // A queued row with no job at all, ordered before the counts were written:
  // no place in the queue to name, and no guess about what nobody counted.
  const [orphan] = await sql<{ id: string }[]>`
    insert into montages (memory_id, ordered_by, params)
    values (${memory.id}, ${organizer.user.id}, ${sql.json({ target_seconds: 60 })})
    returning id
  `;
  const again = (await list(app, organizer.token, memory.id)).json() as typeof items;
  expect(again.find((item) => item.id === orphan?.id)).toMatchObject({
    photos: null,
    videos: null,
    queue: null,
  });

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
    await stage(id, "prep", "done");
    await stage(id, "analysis", "failed");
    await said(id, "prep", "214 кадров скачаны");
    await said(id, "analysis", "не разобрал, кто в кадре");
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
    { stage: "prep", state: "done" },
    { stage: "analysis", state: "failed" },
    { stage: "directing", state: "pending" },
    { stage: "music", state: "pending" },
    { stage: "assembly", state: "pending" },
  ]);

  // The worker takes it up and starts writing the second attempt. «Повторить»
  // over that is the old `409`, and it wipes nothing — a stray tap on the
  // button must not erase a montage that is being assembled right now.
  await running(montage.id);
  await stage(montage.id, "prep", "running");
  await said(montage.id, "prep", "беру всё заново");
  const refused = await retry(app, organizer.token, memory.id, montage.id);
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toEqual({ error: "montage has not failed", status: "processing" });
  expect(await journalOf(montage.id)).toEqual({ lines: 1, stages: 1 });

  await app.close();
});

test("a montage ordered before the music became a list, or before its wishes went per track, is still listed and can still be repeated", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, 3);
  const ownKey = await track(memory.id, organizer.user.id);

  // As the api wrote them before `music_tracks`: one track by id or by key, no
  // list and no note — and before `music_wishes`: the list, with one note for
  // the whole order beside it. Nothing writes these any more, and no order may
  // ask for them — but the videos ordered with them are still on the shelf.
  const placeOld = async (params: Record<string, string | number | string[]>, status: string) => {
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
  const noted = { target_seconds: 60, music_tracks: [ownKey, "calm"], music_note: "по кругу" };
  const oldFailedById = await placeOld(byId, "failed");
  const oldFailedByKey = await placeOld(byKey, "failed");
  const oldFailedNoted = await placeOld(noted, "failed");
  const oldReady = await placeOld(byId, "processing");
  await assembled(oldReady);
  const oldReadyNoted = await placeOld(noted, "processing");
  await assembled(oldReadyNoted);

  const paramsOf = async () =>
    new Map(
      (
        (await list(app, organizer.token, memory.id)).json() as { id: string; params: object }[]
      ).map((item) => [item.id, item.params]),
    );
  let listed = await paramsOf();
  expect(listed.get(oldFailedById)).toEqual(byId);
  expect(listed.get(oldFailedByKey)).toEqual(byKey);
  expect(listed.get(oldFailedNoted)).toEqual(noted);
  expect(listed.get(oldReady)).toEqual(byId);
  expect(listed.get(oldReadyNoted)).toEqual(noted);

  // The material is gone since — an order for this memory now is a refusal, and
  // repeating a video that fell is not an order: it goes back to the worker as
  // it was, without being weighed again.
  await sql`delete from media_items where memory_id = ${memory.id}`;
  expect((await order(app, organizer.token, memory.id, {})).statusCode).toBe(409);

  for (const id of [oldFailedById, oldFailedByKey, oldFailedNoted]) {
    const again = await retry(app, organizer.token, memory.id, id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id, status: "queued", error_text: null });
    expect(await jobsFor(id)).toEqual([{ type: "montage", status: "queued" }]);
  }
  listed = await paramsOf();
  expect(listed.get(oldFailedById)).toEqual(byId);
  expect(listed.get(oldFailedByKey)).toEqual(byKey);
  expect(listed.get(oldFailedNoted)).toEqual(noted);
  // Nobody ordered anything: the counters stay where they were.
  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 0, user: 0 });

  await app.close();
});

test("only the organizer renames a montage, and a blank name hands it back its default label", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const elsewhere = await createMemory(app, organizer.token);

  await material(memory.id, organizer.user.id, 3);
  await material(elsewhere.id, organizer.user.id, 3);
  // The length names it until somebody does — 65 seconds is «Ролик на 1:05».
  const montage = (await order(app, organizer.token, memory.id, { target_seconds: 65 })).json();
  const stray = (await order(app, organizer.token, elsewhere.id, {})).json();
  expect(montage.name).toBe("Ролик на 1:05");
  expect((await speak(app, organizer.token, "en")).statusCode).toBe(200);
  expect((await list(app, organizer.token, memory.id)).json()).toMatchObject([
    { id: montage.id, name: "Movie of 1:05" },
  ]);
  await speak(app, organizer.token, "ru");

  // The video is everybody's; what it is called is the organizer's alone.
  for (const token of [contributor.token, viewer.token]) {
    const refused = await rename(app, token, memory.id, montage.id, "Свадьба Ани и Пети");
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }

  const named = await rename(app, organizer.token, memory.id, montage.id, "Свадьба Ани и Пети");
  expect(named.statusCode).toBe(200);
  expect(named.json()).toMatchObject({ id: montage.id, name: "Свадьба Ани и Пети" });

  // Blank — spaces included — is «не назвали», not a name of its own: the row
  // goes back to null and the label back to the length, the way `nameOf` cleans it.
  const blanked = await rename(app, organizer.token, memory.id, montage.id, "   ");
  expect(blanked.statusCode).toBe(200);
  expect(blanked.json()).toMatchObject({ id: montage.id, name: "Ролик на 1:05" });

  // Never existed, not a uuid, and alive but in another memory — one answer for
  // all three, and the stray is untouched by having been asked about.
  for (const id of [randomUUID(), "not-a-uuid", stray.id]) {
    const answer = await rename(app, organizer.token, memory.id, id, "x");
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  expect((await list(app, organizer.token, elsewhere.id)).json()).toMatchObject([
    { id: stray.id, name: expect.any(String) },
  ]);

  // No session at all — the same 401 the other routes give, and no row moved behind it.
  const anonymous = await app.inject({
    method: "PATCH",
    url: `/memories/${memory.id}/montages/${montage.id}`,
    payload: { name: "x" },
  });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});

test("only the organizer deletes a montage, and it takes the counter, the queue, the watches and the layout with it", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const neighbour = await createMemory(app, organizer.token);

  const [media] = await material(memory.id, organizer.user.id, 3);
  if (!media) throw new Error("the fixture wrote no media row");
  await material(neighbour.id, organizer.user.id, 3);
  const gone = (await order(app, organizer.token, memory.id, {})).json();
  const kept = (await order(app, organizer.token, neighbour.id, {})).json();
  await assembled(gone.id);
  await assembled(kept.id);

  // Watched, laid out — everything a ready video picks up on the way, and
  // everything a delete has to take with it.
  await markWatched(app, organizer.token, memory.id, gone.id);
  await markWatched(app, viewer.token, memory.id, gone.id);
  await sql`
    insert into montage_frames (montage_id, media_id, start_seconds, duration_seconds)
    values (${gone.id}, ${media}, 0, 3)
  `;
  expect(await watchesOf(gone.id)).toHaveLength(2);
  expect(await layoutOf(gone.id)).toBe(1);

  // The video is everybody's; taking it away is the organizer's alone.
  for (const token of [contributor.token, viewer.token]) {
    const refused = await removeMontage(app, token, memory.id, gone.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }

  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 1, user: 2 });
  const removed = await removeMontage(app, organizer.token, memory.id, gone.id);
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toEqual({ ok: true });

  // The card's own count follows the row down — the tally of what was ordered
  // (`user_usage`) does not, because a deleted video was still made.
  expect(await counters(memory.id, organizer.user.id)).toEqual({ memory: 0, user: 2 });
  expect(await montageRows(memory.id)).toEqual([]);
  expect(await jobsFor(gone.id)).toEqual([]);
  expect(await watchesOf(gone.id)).toEqual([]);
  expect(await layoutOf(gone.id)).toBe(0);

  // The neighbour's video, and its own tally, are untouched.
  expect(await montageRows(neighbour.id)).toEqual([{ id: kept.id, status: "ready" }]);
  expect(await counters(neighbour.id, organizer.user.id)).toEqual({ memory: 1, user: 2 });

  // Never existed, not a uuid, already gone, and alive but in another memory —
  // one answer for all four.
  for (const id of [randomUUID(), "not-a-uuid", gone.id, kept.id]) {
    const answer = await removeMontage(app, organizer.token, memory.id, id);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  const anonymous = await app.inject({
    method: "DELETE",
    url: `/memories/${memory.id}/montages/${kept.id}`,
  });
  expect(anonymous.statusCode).toBe(401);
  expect(await montageRows(neighbour.id)).toEqual([{ id: kept.id, status: "ready" }]);

  await app.close();
});
