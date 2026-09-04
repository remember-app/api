import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, afterEach, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";
import { headSize } from "./r2.ts";

/**
 * Live against the real Postgres and the real object store — MinIO from
 * `docker-compose`, which speaks the same S3 API R2 does, so the presigning
 * these tests exercise is the presigning production runs.
 */

const email = () => testEmail("task20");
const titleTag = "task20-test";
const title = () => `${titleTag} ${randomUUID()}`;

// Everything this file writes hangs off its own memories and its own users.
// The queue rows go first: `jobs` belongs to montage, and only the rows this
// file put there may be taken back out.
afterAll(async () => {
  await sql`
    delete from jobs where ref in (
      select id::text from media_items where memory_id in (
        select id from memories where title like ${`${titleTag} %`}
      )
    )
  `;
  await sql`delete from memories where title like ${`${titleTag} %`}`;
  await cleanupTestUsers("task20");
  await sql.end();
});

// The limit tests move the ceilings; nothing may leak into the next test.
const limitKnobs = [
  "MEDIA_MAX_FILE_BYTES",
  "MEDIA_MAX_VIDEO_SECONDS",
  "MEMORY_MAX_STORAGE_BYTES",
  "MEMORY_MAX_FILES",
  "R2_ENDPOINT",
] as const;
const original = Object.fromEntries(limitKnobs.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of limitKnobs) {
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

const intent = (app: App, token: string, memoryId: string, payload: Record<string, unknown>) =>
  app.inject(as(token, { method: "POST", url: `/memories/${memoryId}/media`, payload }));

const photo = { kind: "photo", size_bytes: 1024, captured_at: "2026-09-02T19:30:00+03:00" };

/** A member of the given standing, put in the way an invite would put them. */
async function member(app: App, lines: string[], memoryId: string, role: MemberRole, by: string) {
  const person = await signIn(app, lines, email());
  await sql`
    insert into memory_members (memory_id, user_id, role, invited_by)
    values (${memoryId}, ${person.user.id}, ${role}, ${by})
  `;
  return person;
}

/** How many records this memory holds, whatever their state. */
const mediaCount = async (memoryId: string) => {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int from media_items where memory_id = ${memoryId}
  `;
  return row?.count;
};

/** Pushes bytes at the presigned links exactly as the phone would. */
async function sendParts(
  parts: { part_number: number; url: string }[],
  chunks: Buffer[],
): Promise<{ part_number: number; etag: string }[]> {
  return Promise.all(
    parts.map(async ({ part_number, url }) => {
      const sent = await fetch(url, { method: "PUT", body: chunks[part_number - 1] });
      expect(sent.status).toBe(200);
      return { part_number, etag: sent.headers.get("etag") ?? "" };
    }),
  );
}

test("who may put material in: viewer no, contributor and organizer yes, stranger sees nothing", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, lines, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, lines, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, lines, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, lines, email());

  for (const token of [organizer.token, contributor.token]) {
    const asked = await intent(app, token, memory.id, photo);
    expect(asked.statusCode).toBe(201);
    const body = asked.json();
    expect(body.status).toBe("pending_upload");
    // A signed link straight at the store, one per part, and the API is not on
    // the path the bytes take.
    expect(body.upload.parts).toHaveLength(1);
    expect(body.upload.parts[0]).toMatchObject({ part_number: 1 });
    const url = new URL(body.upload.parts[0].url);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("uploadId")).toBe(body.upload.upload_id);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(body.upload.key).toBe(`originals/${body.id}`);

    const [row] = await sql`select * from media_items where id = ${body.id}`;
    expect(row?.status).toBe("pending_upload");
    expect(row?.size_bytes).toBe("1024");
    expect(row?.original_key).toBe(`originals/${body.id}`);
  }

  // A viewer is in the memory and may look at it — this is the one refusal on
  // this route that is about standing rather than existence.
  const looking = await intent(app, viewer.token, memory.id, photo);
  expect(looking.statusCode).toBe(403);
  expect(looking.json()).toEqual({ error: "forbidden" });

  // Somebody else's memory, one that never existed and an id that is not a
  // uuid: byte for byte the same answer (README, «404 один на всех»).
  for (const id of [memory.id, randomUUID(), "not-a-uuid"]) {
    const answer = await intent(app, stranger.token, id, photo);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  const anonymous = await app.inject({
    method: "POST",
    url: `/memories/${memory.id}/media`,
    payload: photo,
  });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});

test("every limit refuses before anything is written, and each one comes from the environment", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, lines, email());
  const memory = await createMemory(app, organizer.token);

  process.env.MEDIA_MAX_FILE_BYTES = "1024";
  process.env.MEDIA_MAX_VIDEO_SECONDS = "5";
  process.env.MEMORY_MAX_STORAGE_BYTES = "4096";
  process.env.MEMORY_MAX_FILES = "2";

  const tooBig = await intent(app, organizer.token, memory.id, { ...photo, size_bytes: 1025 });
  expect(tooBig.statusCode).toBe(413);
  expect(tooBig.json()).toEqual({ error: "file is too large", limit_bytes: 1024 });

  const tooLong = await intent(app, organizer.token, memory.id, {
    kind: "video",
    size_bytes: 100,
    duration_seconds: 5.5,
  });
  expect(tooLong.statusCode).toBe(413);
  expect(tooLong.json()).toEqual({ error: "video is too long", limit_seconds: 5 });

  // A video whose length is unknown cannot be held to the limit at all, so it
  // is not taken.
  const noDuration = await intent(app, organizer.token, memory.id, {
    kind: "video",
    size_bytes: 100,
  });
  expect(noDuration.statusCode).toBe(400);

  // The memory's own ceilings, read off its counters.
  await sql`update memories set storage_bytes = 4000, media_count = 0 where id = ${memory.id}`;
  const noRoom = await intent(app, organizer.token, memory.id, { ...photo, size_bytes: 97 });
  expect(noRoom.statusCode).toBe(409);
  expect(noRoom.json()).toEqual({ error: "memory is out of space", limit_bytes: 4096 });

  await sql`update memories set storage_bytes = 0, media_count = 2 where id = ${memory.id}`;
  const full = await intent(app, organizer.token, memory.id, photo);
  expect(full.statusCode).toBe(409);
  expect(full.json()).toEqual({ error: "memory is full", limit_files: 2 });

  // Five refusals, and not one of them left a record or a key behind.
  expect(await mediaCount(memory.id)).toBe(0);

  // The same file goes through the moment the ceiling is raised — the numbers
  // are the environment's, not the code's.
  await sql`update memories set storage_bytes = 0, media_count = 0 where id = ${memory.id}`;
  process.env.MEDIA_MAX_FILE_BYTES = "2048";
  const fits = await intent(app, organizer.token, memory.id, { ...photo, size_bytes: 1025 });
  expect(fits.statusCode).toBe(201);

  await app.close();
});

test("without a bucket the upload says so rather than blaming the caller", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, lines, email());
  const memory = await createMemory(app, organizer.token);

  delete process.env.R2_ENDPOINT;
  const asked = await intent(app, organizer.token, memory.id, photo);
  expect(asked.statusCode).toBe(503);
  expect(asked.json()).toEqual({ error: "storage not configured" });

  await app.close();
});

test("the callback moves the counters, queues the preview, and repeats harmlessly", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, lines, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, lines, memory.id, "contributor", organizer.user.id);

  const bytes = Buffer.alloc(4096, 3);
  const asked = await intent(app, contributor.token, memory.id, {
    ...photo,
    size_bytes: bytes.length,
  });
  expect(asked.statusCode).toBe(201);
  const { id, upload } = asked.json();

  const parts = await sendParts(upload.parts, [bytes]);
  const complete = (payload: { parts: { part_number: number; etag: string }[] }) =>
    app.inject(
      as(contributor.token, {
        method: "POST",
        url: `/memories/${memory.id}/media/${id}/complete`,
        payload,
      }),
    );

  const done = await complete({ parts });
  expect(done.statusCode).toBe(200);
  expect(done.json()).toEqual({ id, status: "processing" });

  const [item] = await sql`select * from media_items where id = ${id}`;
  expect(item?.status).toBe("processing");
  // The size R2 measured, not the one the client declared — they agree here,
  // and the point is which of the two was written.
  expect(item?.size_bytes).toBe("4096");

  const counted = async () => {
    const [row] = await sql`
      select storage_bytes, media_count from memories where id = ${memory.id}
    `;
    const [usage] = await sql`
      select storage_bytes, upload_count from user_usage where user_id = ${contributor.user.id}
    `;
    const [queued] = await sql<{ count: number }[]>`
      select count(*)::int from jobs where type = 'media_preview' and ref = ${id}
    `;
    return { row, usage, jobs: queued?.count };
  };

  expect(await counted()).toEqual({
    row: { storage_bytes: "4096", media_count: 1 },
    usage: { storage_bytes: "4096", upload_count: 1 },
    jobs: 1,
  });

  // The phone that never heard the first answer asks again. Same answer, and
  // nothing counted twice — no second job, no doubled bytes.
  const again = await complete({ parts });
  expect(again.statusCode).toBe(200);
  expect(again.json()).toEqual({ id, status: "processing" });
  expect(await counted()).toEqual({
    row: { storage_bytes: "4096", media_count: 1 },
    usage: { storage_bytes: "4096", upload_count: 1 },
    jobs: 1,
  });

  // Somebody else's record, in a memory they are in, is still a 404: finishing
  // an upload belongs to whoever started it.
  const notTheirs = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/media/${id}/complete`,
      payload: { parts },
    }),
  );
  expect(notTheirs.statusCode).toBe(404);

  await app.close();
});

test("a stale link is asked for again: same record, same upload, parts already sent survive", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, lines, email());
  const memory = await createMemory(app, organizer.token);

  const bytes = Buffer.alloc(2048, 9);
  const asked = await intent(app, organizer.token, memory.id, {
    ...photo,
    size_bytes: bytes.length,
  });
  const { id, upload } = asked.json();

  // The part goes up on the first link, and then that link is treated as lost.
  const parts = await sendParts(upload.parts, [bytes]);

  const reissued = await app.inject(
    as(organizer.token, { method: "GET", url: `/memories/${memory.id}/media/${id}/upload` }),
  );
  expect(reissued.statusCode).toBe(200);
  const fresh = reissued.json();
  expect(fresh.id).toBe(id);
  expect(fresh.status).toBe("pending_upload");
  // The same multipart upload — a new one would have thrown the part above
  // away, which is the whole of «докачка, а не заново».
  expect(fresh.upload.upload_id).toBe(upload.upload_id);
  expect(fresh.upload.key).toBe(upload.key);

  // No second record was made for the same file.
  expect(await mediaCount(memory.id)).toBe(1);

  // And the proof that the part survived: the upload completes off the etag
  // the *first* link produced.
  const done = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/media/${id}/complete`,
      payload: { parts },
    }),
  );
  expect(done.statusCode).toBe(200);
  expect(done.json().status).toBe("processing");

  // Finished is finished: a link now would overwrite what the worker is about
  // to read.
  const late = await app.inject(
    as(organizer.token, { method: "GET", url: `/memories/${memory.id}/media/${id}/upload` }),
  );
  expect(late.statusCode).toBe(409);

  await app.close();
});

test("a file bigger than one part is handed one signed link per part", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, lines, email());
  const memory = await createMemory(app, organizer.token);

  // 8 MiB parts by default, so this is three of them, the last a stub. Nothing
  // is uploaded here — the record stays pending and is swept with the memory.
  const asked = await intent(app, organizer.token, memory.id, {
    ...photo,
    size_bytes: 8 * 1024 ** 2 * 2 + 1,
  });
  expect(asked.statusCode).toBe(201);
  const { upload } = asked.json();
  expect(upload.part_size).toBe(8 * 1024 ** 2);
  expect(upload.parts.map((p: { part_number: number }) => p.part_number)).toEqual([1, 2, 3]);
  for (const part of upload.parts) {
    expect(new URL(part.url).searchParams.get("partNumber")).toBe(String(part.part_number));
  }

  await app.close();
});

// The declared size is the client's number; the measured one is R2's. Between
// them sits a presigned PUT that carries no length of its own, which is what
// this refuses to let through.
test("a file that arrives larger than it was declared is refused, not counted", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, lines, email());
  const memory = await createMemory(app, organizer.token);

  process.env.MEDIA_MAX_FILE_BYTES = "1024";

  // Announced as 100 bytes, so the ceiling of 1024 is never troubled and one
  // part link comes back.
  const asked = await intent(app, organizer.token, memory.id, { ...photo, size_bytes: 100 });
  expect(asked.statusCode).toBe(201);
  const { id, upload } = asked.json();

  // And then filled with four kilobytes, four times the ceiling.
  const parts = await sendParts(upload.parts, [Buffer.alloc(4096, 1)]);
  const done = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/media/${id}/complete`,
      payload: { parts },
    }),
  );

  expect(done.statusCode).toBe(413);
  expect(done.json()).toEqual({ error: "file is too large", limit_bytes: 1024 });

  // Nothing counted, nothing kept — the same as a refusal at intent.
  const [row] = await sql`select storage_bytes, media_count from memories where id = ${memory.id}`;
  expect(row).toEqual({ storage_bytes: "0", media_count: 0 });
  expect(await mediaCount(memory.id)).toBe(0);
  expect(await headSize(upload.key)).toBeNull();

  await app.close();
});

// The etag goes into the XML the api signs with its own credentials, so it is
// pinned to the shape S3 receipts a part with rather than «any string».
test("an etag that is not one is refused at the door", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, lines, email());
  const memory = await createMemory(app, organizer.token);

  const asked = await intent(app, organizer.token, memory.id, photo);
  const { id } = asked.json();

  const bad = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/media/${id}/complete`,
      payload: { parts: [{ part_number: 1, etag: '"a"</ETag></Part><Part><PartNumber>2' }] },
    }),
  );
  expect(bad.statusCode).toBe(400);

  await app.close();
});
