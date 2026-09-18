import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";
import { completeUpload, headSize } from "./r2.ts";

/**
 * Live against the real Postgres and the real object store — MinIO from
 * `docker-compose`, which speaks the S3 API R2 does. Files are pushed all the
 * way in and then deleted, so «ушло из хранилища» is asked of the store itself
 * rather than assumed from a 200.
 */

const email = () => testEmail("task21");
const titleTag = "task21-test";
const title = () => `${titleTag} ${randomUUID()}`;

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
  await cleanupTestUsers("task21");
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

/** The intent alone: a record in `pending_upload` with no bytes behind it. */
async function intent(app: App, token: string, memoryId: string, capturedAt: string, size = 4096) {
  const asked = await app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/media`,
      payload: { kind: "photo", size_bytes: size, captured_at: capturedAt },
    }),
  );
  expect(asked.statusCode).toBe(201);
  return asked.json() as {
    id: string;
    upload: { key: string; upload_id: string; parts: { part_number: number; url: string }[] };
  };
}

/** A whole file in: intent, bytes straight at the store, «загружено». */
async function upload(app: App, token: string, memoryId: string, capturedAt: string) {
  const bytes = Buffer.alloc(4096, 7);
  const { id, upload: plan } = await intent(app, token, memoryId, capturedAt);
  // 8 MiB parts by default, so 4 KiB is exactly one of them.
  const [part] = plan.parts;
  if (!part) throw new Error("the intent handed out no part to upload");
  const sent = await fetch(part.url, { method: "PUT", body: bytes });
  expect(sent.status).toBe(200);
  const done = await app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/media/${id}/complete`,
      payload: { parts: [{ part_number: 1, etag: sent.headers.get("etag") ?? "" }] },
    }),
  );
  expect(done.statusCode).toBe(200);
  return { id, key: plan.key };
}

const gallery = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media` }));

const download = (app: App, token: string, memoryId: string, mediaId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media/${mediaId}/download` }));

const downloadAll = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media/download` }));

const remove = (app: App, token: string, memoryId: string, mediaId: string) =>
  app.inject(as(token, { method: "DELETE", url: `/memories/${memoryId}/media/${mediaId}` }));

const leave = (app: App, token: string, memoryId: string, userId: string) =>
  app.inject(as(token, { method: "DELETE", url: `/memories/${memoryId}/members/${userId}` }));

/** The memory's own tally, as the row holds it. */
const counters = async (memoryId: string) => {
  const [row] = await sql`select storage_bytes, media_count from memories where id = ${memoryId}`;
  return row;
};

/** The per-person tally future pricing will read. */
const usage = async (userId: string) => {
  const [row] = await sql`
    select storage_bytes, upload_count from user_usage where user_id = ${userId}
  `;
  return row;
};

/** How many records and how many queued previews this memory still holds. */
const leftovers = async (memoryId: string, userId?: string) => {
  const of = userId ?? null;
  const [items] = await sql<{ count: number }[]>`
    select count(*)::int from media_items
    where memory_id = ${memoryId}
      and (${of}::uuid is null or uploaded_by = ${of}::uuid)
  `;
  const [jobs] = await sql<{ count: number }[]>`
    select count(*)::int from jobs
    where type = 'media_preview' and ref in (
      select id::text from media_items where memory_id = ${memoryId}
    )
  `;
  return { items: items?.count, jobs: jobs?.count };
};

test("the gallery is open to every member and closed to everyone else", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());

  // Shot second, uploaded first: the gallery is ordered by when a thing was
  // taken, not by when it arrived.
  const late = await upload(app, organizer.token, memory.id, "2026-09-02T20:00:00+03:00");
  const early = await upload(app, contributor.token, memory.id, "2026-09-02T19:00:00+03:00");
  // A record whose bytes are still on their way belongs to nobody's screen yet.
  const inFlight = await intent(app, contributor.token, memory.id, "2026-09-02T21:00:00+03:00");

  // The worker is not running here, so its half is written by hand: a
  // derivative key pointing at bytes that really are in the bucket, which is
  // what makes the signed link below answerable, and the screening's verdict,
  // which comes from the same hand and the same moment. `blur` and not
  // `blurry`: the word is the worker's, out of `projects/montage/selection.py`,
  // and a fixture spelling it its own way pins a value nothing ever writes.
  await sql`
    update media_items
    set thumbnail_key = original_key, screening_rejected = true, screening_reason = 'blur'
    where id = ${early.id}
  `;

  // Every standing sees the same gallery — a viewer above all, since «смотреть
  // галерею» is the whole of what the matrix gives them.
  for (const token of [organizer.token, contributor.token, viewer.token]) {
    const seen = await gallery(app, token, memory.id);
    expect(seen.statusCode).toBe(200);
    const items = seen.json();
    expect(items.map((item: { id: string }) => item.id)).toEqual([early.id, late.id]);
    expect(items.some((item: { id: string }) => item.id === inFlight.id)).toBe(false);

    expect(items[0]).toMatchObject({
      kind: "photo",
      status: "processing",
      uploaded_by: contributor.user.id,
      size_bytes: "4096",
      // What the screening made of it, handed over untouched.
      screening_rejected: true,
      screening_reason: "blur",
    });
    // No derivative yet — the client draws a placeholder, not a broken link.
    expect(items[1].thumbnail_url).toBeNull();
    expect(items[1].preview_url).toBeNull();
    // And no verdict yet either: «ещё не готово», not «looked at and kept» —
    // `false` here would have the organizer told the analysis approved a frame
    // it has never seen.
    expect(items[1].screening_rejected).toBeNull();
    expect(items[1].screening_reason).toBeNull();

    const url = new URL(items[0].thumbnail_url);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  }

  // And the link is not merely shaped right: it opens the object.
  const opened = await fetch(
    new URL((await gallery(app, viewer.token, memory.id)).json()[0].thumbnail_url),
  );
  expect(opened.status).toBe(200);
  expect((await opened.arrayBuffer()).byteLength).toBe(4096);

  // Somebody else's memory, one that never existed and an id that is not a
  // uuid: byte for byte the same answer (README, «404 один на всех»).
  for (const id of [memory.id, randomUUID(), "not-a-uuid"]) {
    const answer = await gallery(app, stranger.token, id);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  const anonymous = await app.inject({ method: "GET", url: `/memories/${memory.id}/media` });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});

test("the original is one signed link away for every member, one file or the whole gallery", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());
  const elsewhere = await createMemory(app, organizer.token);

  // Shot second, uploaded first — the whole-gallery route orders the same way the gallery does.
  const late = await upload(app, organizer.token, memory.id, "2026-09-02T20:00:00+03:00");
  const early = await upload(app, contributor.token, memory.id, "2026-09-02T19:00:00+03:00");
  // Still in flight: no bytes in the store, so neither route may hand out a link to it.
  const inFlight = await intent(app, contributor.token, memory.id, "2026-09-02T21:00:00+03:00");
  const stray = await upload(app, organizer.token, elsewhere.id, "2026-09-02T19:00:00+03:00");

  // «скачивать оригиналы» is every member's, `viewer` included — the matrix gives it to all three,
  // and the link is the whole of what the check gives them.
  for (const token of [organizer.token, contributor.token, viewer.token]) {
    const single = await download(app, token, memory.id, early.id);
    expect(single.statusCode).toBe(200);
    const url = new URL(single.json().url);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    const all = await downloadAll(app, token, memory.id);
    expect(all.statusCode).toBe(200);
    const items = all.json() as { id: string; kind: string; url: string }[];
    expect(items.map((item) => item.id)).toEqual([early.id, late.id]);
    expect(items.some((item) => item.id === inFlight.id)).toBe(false);
    expect(items[0]).toMatchObject({ id: early.id, kind: "photo" });
  }

  // Not merely shaped right: the link opens the real bytes that were sent.
  const opened = await fetch(
    new URL((await download(app, viewer.token, memory.id, early.id)).json().url),
  );
  expect(opened.status).toBe(200);
  expect((await opened.arrayBuffer()).byteLength).toBe(4096);

  // A stranger to the memory gets the house 404 from both routes, byte for byte — standing in the
  // memory is the whole of the check, and there is no lesser answer for somebody outside it.
  for (const answer of [
    await download(app, stranger.token, memory.id, early.id),
    await downloadAll(app, stranger.token, memory.id),
  ]) {
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  // Still in flight, never existed, not a uuid, and a record that is real but belongs to another
  // memory — the single-file route gives the same 404 to all four, and the attempt reads nothing.
  for (const id of [inFlight.id, randomUUID(), "not-a-uuid", stray.id]) {
    const answer = await download(app, organizer.token, memory.id, id);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  // No session at all, on both routes.
  expect(
    (await app.inject({ method: "GET", url: `/memories/${memory.id}/media/${early.id}/download` }))
      .statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ method: "GET", url: `/memories/${memory.id}/media/download` })).statusCode,
  ).toBe(401);

  await app.close();
});

test("own material anyone deletes, any material the organizer, a neighbour's nobody", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const boris = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const elsewhere = await createMemory(app, organizer.token);

  const hers = await upload(app, anna.token, memory.id, "2026-09-02T19:00:00+03:00");
  expect(await counters(memory.id)).toEqual({ storage_bytes: "4096", media_count: 1 });

  // Standing in the memory is not standing over somebody else's file: a
  // contributor and a viewer are refused alike, and the record survives.
  for (const token of [boris.token, viewer.token]) {
    const refused = await remove(app, token, memory.id, hers.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }
  expect((await leftovers(memory.id)).items).toBe(1);

  // Whoever brought it takes it back — this is ownership, not role.
  const own = await remove(app, anna.token, memory.id, hers.id);
  expect(own.statusCode).toBe(200);
  expect(own.json()).toEqual({ ok: true });

  expect(await leftovers(memory.id)).toEqual({ items: 0, jobs: 0 });
  expect(await counters(memory.id)).toEqual({ storage_bytes: "0", media_count: 0 });
  expect(await usage(anna.user.id)).toEqual({ storage_bytes: "0", upload_count: 0 });
  // The bytes, asked of the store rather than assumed.
  expect(await headSize(hers.key)).toBeNull();

  // The organizer's line of the matrix: any material, not only their own.
  const his = await upload(app, boris.token, memory.id, "2026-09-02T19:30:00+03:00");
  const byOrganizer = await remove(app, organizer.token, memory.id, his.id);
  expect(byOrganizer.statusCode).toBe(200);
  expect(await counters(memory.id)).toEqual({ storage_bytes: "0", media_count: 0 });
  expect(await headSize(his.key)).toBeNull();

  // Gone, never existed, not a uuid, and alive but in another memory — one
  // answer for all four.
  const stray = await upload(app, organizer.token, elsewhere.id, "2026-09-02T19:00:00+03:00");
  for (const id of [his.id, randomUUID(), "not-a-uuid", stray.id]) {
    const answer = await remove(app, organizer.token, memory.id, id);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  // The stray is still where it was: a 404 must not have deleted anything.
  expect((await leftovers(elsewhere.id)).items).toBe(1);

  await app.close();
});

test("leaving and being excluded both take the person's material with them", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const boris = await member(app, memory.id, "contributor", organizer.user.id);

  const hers = await upload(app, anna.token, memory.id, "2026-09-02T19:00:00+03:00");
  // A record still on its way out when she goes. It never moved a counter, so
  // it must go without moving one either — the tally below is the check.
  const inFlight = await intent(app, anna.token, memory.id, "2026-09-02T19:15:00+03:00");
  // One part actually in the bucket, so the multipart she leaves behind is a
  // real one with real bytes in it and not an empty shell.
  const midPart = inFlight.upload.parts[0];
  if (!midPart) throw new Error("the intent handed out no part to upload");
  const midSent = await fetch(midPart.url, { method: "PUT", body: Buffer.alloc(4096, 5) });
  expect(midSent.status).toBe(200);
  const his = await upload(app, boris.token, memory.id, "2026-09-02T19:30:00+03:00");

  expect(await counters(memory.id)).toEqual({ storage_bytes: "8192", media_count: 2 });
  expect((await leftovers(memory.id)).jobs).toBe(2);

  // She walks out herself.
  const left = await leave(app, anna.token, memory.id, anna.user.id);
  expect(left.statusCode).toBe(200);

  expect(await leftovers(memory.id, anna.user.id)).toEqual({ items: 0, jobs: 1 });
  // His material stayed, and the tally is exactly his — not hers taken off
  // twice, and not the in-flight record taken off at all.
  expect(await counters(memory.id)).toEqual({ storage_bytes: "4096", media_count: 1 });
  expect(await usage(anna.user.id)).toEqual({ storage_bytes: "0", upload_count: 0 });
  expect(await usage(boris.user.id)).toEqual({ storage_bytes: "4096", upload_count: 1 });
  expect(await headSize(hers.key)).toBeNull();
  expect(await headSize(inFlight.upload.key)).toBeNull();
  expect(await headSize(his.key)).toBe(4096);
  // The upload she never finished is released, not merely unreferenced: a
  // `DELETE` on the key leaves a multipart's parts in the bucket, and the row
  // that named this one is gone, so nothing could ever abort it afterwards.
  // Sealing it now is what must fail.
  await expect(
    completeUpload(inFlight.upload.key, inFlight.upload.upload_id, [
      { part_number: 1, etag: midSent.headers.get("etag") ?? "" },
    ]),
  ).rejects.toThrow();
  // And she is out: the gallery she could read a moment ago is now 404.
  expect((await gallery(app, anna.token, memory.id)).statusCode).toBe(404);

  // The organizer shows the other one out.
  const excluded = await leave(app, organizer.token, memory.id, boris.user.id);
  expect(excluded.statusCode).toBe(200);

  expect(await leftovers(memory.id)).toEqual({ items: 0, jobs: 0 });
  expect(await counters(memory.id)).toEqual({ storage_bytes: "0", media_count: 0 });
  expect(await usage(boris.user.id)).toEqual({ storage_bytes: "0", upload_count: 0 });
  expect(await headSize(his.key)).toBeNull();
  expect((await gallery(app, organizer.token, memory.id)).json()).toEqual([]);

  // Nobody there to remove: still the one answer of this family, and the
  // memory is untouched by the attempt.
  const twice = await leave(app, organizer.token, memory.id, boris.user.id);
  expect(twice.statusCode).toBe(404);
  expect(twice.body).toBe('{"error":"not found"}');

  await app.close();
});
