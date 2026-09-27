import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, signIn } from "../auth/testing.ts";
import {
  assembled,
  fell,
  list,
  markWatched,
  material,
  order,
  underTag,
  watchesOf,
} from "./testing.ts";

/**
 * «Посмотрели» — the screen's own knock when a ready video opens (`watched.ts`).
 */

const { email, createMemory, member, cleanup } = underTag("task423watched");

afterAll(cleanup);

test("only a ready montage is marked watched, a second mark changes nothing, and an unfinished one always shows nobody", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const elsewhere = await createMemory(app, organizer.token);

  await material(memory.id, organizer.user.id, 3);
  await material(elsewhere.id, organizer.user.id, 3);
  const queued = (await order(app, organizer.token, memory.id, {})).json();
  const failed = (await order(app, organizer.token, memory.id, {})).json();
  await fell(failed.id);
  const stray = (await order(app, organizer.token, elsewhere.id, {})).json();

  // Nothing to watch yet — the same 409 whether it is still waiting or has
  // fallen over, and no row goes down under either.
  for (const [montage, status] of [
    [queued, "queued"],
    [failed, "failed"],
  ] as const) {
    const refused = await markWatched(app, viewer.token, memory.id, montage.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "montage is not ready", status });
    expect(await watchesOf(montage.id)).toEqual([]);
  }

  // Unfinished videos are never even asked about (`montages.ts`): the list
  // always says nobody, and that is not merely «nobody has yet».
  const unfinished = (await list(app, organizer.token, memory.id)).json() as {
    id: string;
    watched_by: unknown[];
  }[];
  for (const montage of unfinished) expect(montage.watched_by).toEqual([]);

  await assembled(queued.id);
  const first = await markWatched(app, viewer.token, memory.id, queued.id);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ ok: true });
  const [row] = await watchesOf(queued.id);
  expect(row?.user_id).toBe(viewer.user.id);

  // On the list, in the shape the frame sheet already gives a person in
  // (`ordered_by`, `watchesOf` → `PublicUser`).
  const listed = (await list(app, organizer.token, memory.id)).json() as {
    id: string;
    watched_by: { id: string }[];
  }[];
  expect(listed.find((m) => m.id === queued.id)?.watched_by).toEqual([
    { id: viewer.user.id, username: viewer.user.username, name: viewer.user.name },
  ]);

  // Twice over changes nothing: one row, the same `watched_at`, not a history
  // of showings.
  const second = await markWatched(app, viewer.token, memory.id, queued.id);
  expect(second.statusCode).toBe(200);
  const again = await watchesOf(queued.id);
  expect(again).toHaveLength(1);
  expect(again[0]?.watched_at).toEqual(row?.watched_at);

  // The organizer watching too adds a second face beside the first.
  await markWatched(app, organizer.token, memory.id, queued.id);
  expect(new Set((await watchesOf(queued.id)).map((w) => w.user_id))).toEqual(
    new Set([viewer.user.id, organizer.user.id]),
  );

  // Never existed, not a uuid, and alive but in another memory — one answer
  // for all three, and the stray untouched by having been asked about.
  for (const id of [randomUUID(), "not-a-uuid", stray.id]) {
    const answer = await markWatched(app, organizer.token, memory.id, id);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  expect(await watchesOf(stray.id)).toEqual([]);

  const anonymous = await app.inject({
    method: "POST",
    url: `/memories/${memory.id}/montages/${queued.id}/watched`,
  });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});
