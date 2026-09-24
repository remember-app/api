import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, signIn } from "../auth/testing.ts";
import {
  alike,
  counters,
  jobsFor,
  material,
  montageRows,
  order,
  preview,
  underTag,
} from "./testing.ts";

/**
 * «Итог перед монтажом»: те же числа, что покажет экран, и обещание, что
 * заказанное следом не будет отказано другим ответом (`summary.ts`).
 */

const { email, createMemory, member, cleanup } = underTag("task53summary");

afterAll(cleanup);

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
