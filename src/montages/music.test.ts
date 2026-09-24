import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, afterEach, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import { headSize } from "../media/r2.ts";
import type { MemberRole } from "../memories/plugin.ts";

/**
 * The organizer's own track, taken all the way in: live against the real
 * Postgres and the real object store — MinIO from `docker-compose`, which
 * speaks the same S3 API R2 does, so the presigning here is the presigning
 * production runs.
 */

const email = () => testEmail("task152");
const titleTag = "task152-test";
const title = () => `${titleTag} ${randomUUID()}`;
const mine = `${titleTag} %`;

// The queue rows go first: `jobs` belongs to montage, and only the rows this
// file put there may be taken back out. The tracks need no line of their own —
// `music_uploads` hangs off the memory and leaves with it.
afterAll(async () => {
  await sql`
    delete from jobs where type = 'montage' and ref in (
      select id::text from montages where memory_id in (
        select id from memories where title like ${mine}
      )
    )
  `;
  await sql`delete from memories where title like ${mine}`;
  await cleanupTestUsers("task152");
  await sql.end();
});

// The limit test moves the ceiling; nothing may leak into the next test.
const knobs = ["MEDIA_MAX_FILE_BYTES", "R2_ENDPOINT"] as const;
const original = Object.fromEntries(knobs.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of knobs) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
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
  return created.json() as { id: string };
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
 * Material in the memory, written where the upload would have left it. Videos
 * of two minutes, because the length a montage may be ordered at is cut from
 * the material (`montages.ts`): three photos are worth six seconds, and the
 * order below asks for the default minute.
 */
async function material(memoryId: string, uploadedBy: string, count: number) {
  for (let n = 0; n < count; n++) {
    await sql`
      insert into media_items (
        memory_id, uploaded_by, kind, status, original_key, size_bytes, duration_seconds
      )
      values (
        ${memoryId}, ${uploadedBy}, 'video', 'ready', ${`originals/${randomUUID()}`}, 4096, 120
      )
    `;
  }
}

const intent = (app: App, token: string, memoryId: string, sizeBytes: number) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/music`,
      payload: { size_bytes: sizeBytes },
    }),
  );

const complete = (
  app: App,
  token: string,
  memoryId: string,
  trackId: string,
  parts: { part_number: number; etag: string }[],
) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/music/${trackId}/complete`,
      payload: { parts },
    }),
  );

/** Pushes the bytes at the presigned links exactly as the phone would. */
async function sendParts(parts: { part_number: number; url: string }[], body: Buffer) {
  return Promise.all(
    parts.map(async ({ part_number, url }) => {
      const sent = await fetch(url, { method: "PUT", body });
      expect(sent.status).toBe(200);
      return { part_number, etag: sent.headers.get("etag") ?? "" };
    }),
  );
}

/** Where «Послушать» knocks. The ids are written out, not read off the source. */
const listen = (trackId: string) => `/music/tracks/${trackId}`;
const shelf = ["bright", "warm", "calm", "night", "road"];

const tracksIn = async (memoryId: string) =>
  sql<{ id: string; status: string }[]>`
    select id, status from music_uploads where memory_id = ${memoryId}
  `;

test("the organizer brings their own track, and the montage order names it by key", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());

  // The track is a preference about the video, and the video is ordered by one
  // person: everyone else in the memory is told the same 403 the order gives.
  for (const token of [contributor.token, viewer.token]) {
    const refused = await intent(app, token, memory.id, 4096);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }
  // Somebody else's memory, one that never existed and an id that is not a
  // uuid: byte for byte the same answer (README, «404 один на всех»).
  for (const id of [memory.id, randomUUID(), "not-a-uuid"]) {
    const answer = await intent(app, stranger.token, id, 4096);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  const anonymous = await app.inject({
    method: "POST",
    url: `/memories/${memory.id}/music`,
    payload: { size_bytes: 4096 },
  });
  expect(anonymous.statusCode).toBe(401);

  const bytes = Buffer.alloc(4096, 7);
  const asked = await intent(app, organizer.token, memory.id, bytes.length);
  expect(asked.statusCode).toBe(201);
  const plan = asked.json();
  expect(plan.status).toBe("pending_upload");
  // The key is by the row's id, as an original's is, and it comes back in the
  // answer: assembling it on the client is exactly what the order must not do.
  expect(plan.upload.key).toBe(`music/${plan.id}`);
  expect(plan.upload.parts).toHaveLength(1);
  const url = new URL(plan.upload.parts[0].url);
  expect(url.pathname).toContain(plan.upload.key);
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

  // Named but not uploaded: the key is real and the bytes are not, so the
  // order must not take it — that montage would fall over at the worker.
  await material(memory.id, organizer.user.id, 3);
  const early = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/montages`,
      payload: { music_tracks: [plan.upload.key] },
    }),
  );
  expect(early.statusCode).toBe(400);
  expect(early.json()).toEqual({
    error: "no such music track",
    music_tracks: [plan.upload.key],
  });

  const parts = await sendParts(plan.upload.parts, bytes);
  // Only the person who started the upload may finish it — ownership, not role,
  // exactly as with media. And an id that is not a uuid, or a track of another
  // memory, is the same «no such track».
  expect((await complete(app, contributor.token, memory.id, plan.id, parts)).statusCode).toBe(404);
  for (const id of [randomUUID(), "not-a-uuid"]) {
    expect((await complete(app, organizer.token, memory.id, id, parts)).statusCode).toBe(404);
  }

  const done = await complete(app, organizer.token, memory.id, plan.id, parts);
  expect(done.statusCode).toBe(200);
  expect(done.json()).toEqual({ id: plan.id, status: "ready", key: plan.upload.key });
  // The bytes are in the store, all of them, and the size recorded is the one
  // the store holds rather than the one the client declared.
  expect(await headSize(plan.upload.key)).toBe(bytes.length);

  // The repeat callback, which is the ordinary case for a phone that lost the
  // answer to the first one: the same answer, and still one track.
  const again = await complete(app, organizer.token, memory.id, plan.id, parts);
  expect(again.statusCode).toBe(200);
  expect(again.json()).toEqual({ id: plan.id, status: "ready", key: plan.upload.key });
  expect(await tracksIn(memory.id)).toEqual([{ id: plan.id, status: "ready" }]);

  // And the whole point of it: the order names the track by that key, and it
  // lands in `params` — in `music_tracks`, beside the shelf ids, because that
  // is the one list the worker reads the music out of.
  const ordered = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/montages`,
      payload: { music_tracks: [plan.upload.key, "calm"] },
    }),
  );
  expect(ordered.statusCode).toBe(201);
  expect(ordered.json().params).toEqual({
    target_seconds: 60,
    music_tracks: [plan.upload.key, "calm"],
  });

  await app.close();
});

test("a track bigger than the ceiling is refused, whichever size gave it away", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  process.env.MEDIA_MAX_FILE_BYTES = "1500";
  // Declared past the ceiling: refused before anything is written, so neither a
  // row nor a multipart upload is left behind.
  const declared = await intent(app, organizer.token, memory.id, 4096);
  expect(declared.statusCode).toBe(413);
  expect(declared.json()).toEqual({ error: "file is too large", limit_bytes: 1500 });
  expect(await tracksIn(memory.id)).toEqual([]);

  // Declared small and sent big — a presigned part carries no length, so this
  // is the only place it can be caught. The record and the object both go.
  const asked = await intent(app, organizer.token, memory.id, 1024);
  expect(asked.statusCode).toBe(201);
  const plan = asked.json();
  const parts = await sendParts(plan.upload.parts, Buffer.alloc(2048, 3));
  const refused = await complete(app, organizer.token, memory.id, plan.id, parts);
  expect(refused.statusCode).toBe(413);
  expect(refused.json()).toEqual({ error: "file is too large", limit_bytes: 1500 });
  expect(await tracksIn(memory.id)).toEqual([]);
  expect(await headSize(plan.upload.key)).toBeNull();

  await app.close();
});

test("without a bucket the track routes say so, the way the media ones do", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  delete process.env.R2_ENDPOINT;
  const asked = await intent(app, organizer.token, memory.id, 4096);
  expect(asked.statusCode).toBe(503);
  expect(asked.json()).toEqual({ error: "storage not configured" });
  const sealed = await complete(app, organizer.token, memory.id, randomUUID(), [
    { part_number: 1, etag: "abc" },
  ]);
  expect(sealed.statusCode).toBe(503);
  const listened = await app.inject(as(organizer.token, { method: "GET", url: listen("bright") }));
  expect(listened.statusCode).toBe(503);

  await app.close();
});

test("every track on the shelf can be listened to, and nothing else can", async () => {
  const { app } = buildTestApp();
  // Signed in and nothing more: no memory of their own, no membership, no role
  // — the library is one shelf for the whole product.
  const listener = await signIn(app, email());

  for (const id of shelf) {
    const answer = await app.inject(as(listener.token, { method: "GET", url: listen(id) }));
    expect(answer.statusCode).toBe(200);
    // The worker's key, signed: `tracks/<id>.mp3` is where `python worker.py
    // tracks` lays the five files out, and the signature is what makes the link
    // openable by a phone that holds no credentials.
    const url = new URL(answer.json().url);
    expect(url.pathname.endsWith(`/tracks/${id}.mp3`)).toBe(true);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  }

  // Not on the shelf — including the one that looks like the key itself. The
  // same list refuses these at the order, so the two can never disagree.
  for (const id of ["nope", "bright.mp3", "BRIGHT", randomUUID()]) {
    const refused = await app.inject(as(listener.token, { method: "GET", url: listen(id) }));
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toBe('{"error":"not found"}');
  }

  expect((await app.inject({ method: "GET", url: listen("bright") })).statusCode).toBe(401);

  await app.close();
});
