import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";

/**
 * «Сведения о кадре» (doc-02). Live against the real Postgres, as everything
 * here does. No object store: this sheet signs nothing — what the worker would
 * have written into the row is written straight into it, which is the only way
 * to ask what the route does with a camera, a place and a layout that api never
 * produces itself.
 */

const email = () => testEmail("task191");
const titleTag = "task191-test";
const title = () => `${titleTag} ${randomUUID()}`;
const mine = `${titleTag} %`;

// The memories go before the people: `montages.ordered_by` deliberately has no
// ON DELETE, so a user row cannot leave while a montage of theirs stands.
// `montage_frames` needs no line of its own — it hangs off both the montage and
// the media item, and cascades with either.
afterAll(async () => {
  await sql`delete from memories where title like ${mine}`;
  await cleanupTestUsers("task191");
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

/**
 * A frame in the memory, written where the upload and then the worker's probe
 * would have left it. Everything past the first two arguments is the worker's
 * half — absent means «ещё не посмотрели», which is most of what this file is
 * about.
 */
async function frame(
  memoryId: string,
  uploadedBy: string,
  fields: {
    status?: "ready" | "processing" | "pending_upload";
    captured_at?: string;
    file_name?: string;
    width?: number;
    height?: number;
    camera_model?: string;
    focal_length_mm?: number;
    aperture?: number;
    latitude?: number;
    longitude?: number;
  } = {},
) {
  const [row] = await sql<{ id: string }[]>`
    insert into media_items
      (memory_id, uploaded_by, kind, status, original_key, size_bytes, captured_at,
       file_name, width, height, camera_model, focal_length_mm, aperture, latitude, longitude)
    values (${memoryId}, ${uploadedBy}, 'photo', ${fields.status ?? "ready"},
            ${`originals/${randomUUID()}`}, 4404019, ${fields.captured_at ?? null},
            ${fields.file_name ?? null}, ${fields.width ?? null}, ${fields.height ?? null},
            ${fields.camera_model ?? null}, ${fields.focal_length_mm ?? null},
            ${fields.aperture ?? null}, ${fields.latitude ?? null}, ${fields.longitude ?? null})
    returning id
  `;
  if (!row) throw new Error("insert into media_items returned no row");
  return row.id;
}

/** A video of the memory, as the worker would have left it when it finished. */
async function montage(
  memoryId: string,
  orderedBy: string,
  fields: {
    status?: "ready" | "queued" | "failed";
    duration_seconds?: number;
    created_at?: string;
  } = {},
) {
  const [row] = await sql<{ id: string }[]>`
    insert into montages (memory_id, ordered_by, status, duration_seconds, created_at)
    values (${memoryId}, ${orderedBy}, ${fields.status ?? "ready"},
            ${fields.duration_seconds ?? 60},
            ${fields.created_at ?? "2026-09-20T12:00:00Z"})
    returning id
  `;
  if (!row) throw new Error("insert into montages returned no row");
  return row.id;
}

/** Where a frame stands in a video — the row the montage worker writes. */
const stands = (montageId: string, mediaId: string, startSeconds: number, seconds = 3) =>
  sql`
    insert into montage_frames (montage_id, media_id, start_seconds, duration_seconds)
    values (${montageId}, ${mediaId}, ${startSeconds}, ${seconds})
  `;

const info = (app: App, token: string, memoryId: string, mediaId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media/${mediaId}` }));

type Sheet = {
  id: string;
  file_name?: string;
  size_bytes: string;
  captured_at: string | null;
  created_at: string;
  width: number | null;
  height: number | null;
  camera_model: string | null;
  focal_length_mm: number | null;
  aperture: number | null;
  latitude: number | null;
  longitude: number | null;
  uploaded_by: { id: string; username: string | null; name: string | null; media_count: number };
  montages: { id: string; duration_seconds: number | null; start_seconds: number }[];
};

test("the sheet says who brought the frame, what the file is and what took it", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const mark = await member(app, memory.id, "contributor", organizer.user.id);

  const id = await frame(memory.id, mark.user.id, {
    captured_at: "2026-09-13T21:47:00+03:00",
    file_name: "IMG_4471.HEIC",
    width: 4032,
    height: 3024,
    camera_model: "iPhone 15 Pro",
    focal_length_mm: 24,
    aperture: 1.8,
    latitude: 55.518,
    longitude: 37.53,
  });
  // Two more of his and one of the organizer's, so the tally is his own and
  // not the memory's. The one still uploading is behind no bytes at all and is
  // not in the gallery either — so it is not among «всего кадров».
  await frame(memory.id, mark.user.id);
  await frame(memory.id, mark.user.id, { status: "processing" });
  await frame(memory.id, mark.user.id, { status: "pending_upload" });
  await frame(memory.id, organizer.user.id);

  const read = await info(app, organizer.token, memory.id, id);
  expect(read.statusCode).toBe(200);
  const sheet = read.json() as Sheet;

  expect(sheet).toMatchObject({
    id,
    file_name: "IMG_4471.HEIC",
    // A bigint comes over as a string, unrounded, as everywhere else.
    size_bytes: "4404019",
    width: 4032,
    height: 3024,
    camera_model: "iPhone 15 Pro",
    focal_length_mm: 24,
    aperture: 1.8,
    latitude: 55.518,
    longitude: 37.53,
    montages: [],
  });
  expect(sheet.captured_at).toBe("2026-09-13T18:47:00.000Z");
  // When it was brought, which the sheet shows beside who brought it.
  expect(Date.parse(sheet.created_at)).toBeGreaterThan(0);
  expect(sheet.uploaded_by).toEqual({
    id: mark.user.id,
    username: mark.user.username,
    name: mark.user.name,
    // Three of his are in the gallery; the fourth is still uploading.
    media_count: 3,
  });

  await app.close();
});

test("a frame nobody has looked at yet is answered without a file name, not with an empty one", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const id = await frame(memory.id, organizer.user.id);

  const read = await info(app, organizer.token, memory.id, id);
  expect(read.statusCode).toBe(200);
  const sheet = read.json() as Sheet;

  // Not `null`, not `""` — the key is simply not there, and the sheet draws no
  // line for it.
  expect("file_name" in sheet).toBe(false);
  // Everything the worker has not written yet is null, which the app reads as
  // «ещё не посчитано» exactly as it reads a missing thumbnail.
  expect(sheet).toMatchObject({
    captured_at: null,
    width: null,
    height: null,
    camera_model: null,
    focal_length_mm: null,
    aperture: null,
    latitude: null,
    longitude: null,
    montages: [],
  });

  await app.close();
});

test("a frame that stands in two finished videos names both, and nothing else", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const id = await frame(memory.id, organizer.user.id);

  const older = await montage(memory.id, organizer.user.id, {
    duration_seconds: 60,
    created_at: "2026-09-19T12:00:00Z",
  });
  const newer = await montage(memory.id, organizer.user.id, {
    duration_seconds: 90,
    created_at: "2026-09-20T12:00:00Z",
  });
  await stands(older, id, 12);
  await stands(newer, id, 72.5);

  // A video that fell over is not something anybody opens from this sheet.
  const broken = await montage(memory.id, organizer.user.id, { status: "failed" });
  await stands(broken, id, 5);
  // And another memory's finished video never belongs here, however the row
  // pointing at it came to be written.
  const elsewhere = await createMemory(app, organizer.token);
  const alien = await montage(elsewhere.id, organizer.user.id);
  await stands(alien, id, 7);

  const read = await info(app, organizer.token, memory.id, id);
  expect(read.statusCode).toBe(200);
  // Newest first, as the list of montages itself is ordered.
  expect((read.json() as Sheet).montages).toEqual([
    { id: newer, duration_seconds: 90, start_seconds: 72.5 },
    { id: older, duration_seconds: 60, start_seconds: 12 },
  ]);

  await app.close();
});

test("every member reads the sheet, the viewer included, and nobody else does", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());
  const id = await frame(memory.id, organizer.user.id, { file_name: "IMG_0001.HEIC" });

  // The matrix gives the viewer «смотреть галерею», and this is one frame of it
  // in words.
  const seen = await info(app, viewer.token, memory.id, id);
  expect(seen.statusCode).toBe(200);
  expect((seen.json() as Sheet).file_name).toBe("IMG_0001.HEIC");

  // A stranger is answered about the memory, not about the frame — the same
  // 404 «no such memory» everything behind the membership check gives.
  const outsider = await info(app, stranger.token, memory.id, id);
  expect(outsider.statusCode).toBe(404);
  expect(outsider.json()).toEqual({ error: "not found" });

  // No session at all.
  const anonymous = await app.inject({
    method: "GET",
    url: `/memories/${memory.id}/media/${id}`,
  });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});

test("a frame of another memory, a frame still uploading and a mangled id are one 404", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const other = await createMemory(app, organizer.token);

  // Theirs, but not of this memory: «no such record» here, for the same reason
  // another memory is «no such memory».
  const elsewhere = await frame(other.id, organizer.user.id);
  expect((await info(app, organizer.token, memory.id, elsewhere)).statusCode).toBe(404);

  // Still uploading: no bytes behind it, and the gallery does not show it
  // either.
  const inFlight = await frame(memory.id, organizer.user.id, { status: "pending_upload" });
  expect((await info(app, organizer.token, memory.id, inFlight)).statusCode).toBe(404);

  // Never existed, and not a uuid at all — the same answer, without a 400 and
  // without a database error.
  expect((await info(app, organizer.token, memory.id, randomUUID())).statusCode).toBe(404);
  const mangled = await info(app, organizer.token, memory.id, "not-a-uuid");
  expect(mangled.statusCode).toBe(404);
  expect(mangled.json()).toEqual({ error: "not found" });

  await app.close();
});

test("the upload intent takes the file name the phone sends, and does without it", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  const asked = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/media`,
      payload: { kind: "photo", size_bytes: 4096, file_name: "IMG_4471.HEIC" },
    }),
  );
  expect(asked.statusCode).toBe(201);
  const { id } = asked.json() as { id: string };

  const [stored] = await sql<{ file_name: string | null }[]>`
    select file_name from media_items where id = ${id}
  `;
  expect(stored?.file_name).toBe("IMG_4471.HEIC");

  // The record is still `pending_upload`, so the sheet does not show it yet —
  // the name is asked of the row. Taken back out through the route, which is
  // also what releases the multipart upload the intent started in the store.
  const removed = await app.inject(
    as(organizer.token, { method: "DELETE", url: `/memories/${memory.id}/media/${id}` }),
  );
  expect(removed.statusCode).toBe(200);

  // A client that sends no name at all is the ordinary case until the app
  // learns to, and it must not be a 400.
  const plain = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/media`,
      payload: { kind: "photo", size_bytes: 4096 },
    }),
  );
  expect(plain.statusCode).toBe(201);
  const second = (plain.json() as { id: string }).id;
  const [blank] = await sql<{ file_name: string | null }[]>`
    select file_name from media_items where id = ${second}
  `;
  expect(blank?.file_name).toBe(null);
  await app.inject(
    as(organizer.token, { method: "DELETE", url: `/memories/${memory.id}/media/${second}` }),
  );

  await app.close();
});
