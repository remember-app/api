import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";
import { materialLeft } from "../montages/material.ts";

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
    status?: "ready" | "processing" | "failed" | "pending_upload";
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
    status?: "ready" | "queued" | "processing" | "failed";
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
  montages: { id: string; name: string; duration_seconds: number | null; start_seconds: number }[];
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
    { id: newer, name: "Ролик на 1:30", duration_seconds: 90, start_seconds: 72.5 },
    { id: older, name: "Ролик на 1:00", duration_seconds: 60, start_seconds: 12 },
  ]);

  await app.close();
});

test("«В роликах» calls a video what the list of montages calls it: its own name, or its length in the reader's words", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const mark = await member(app, memory.id, "contributor", organizer.user.id);
  const id = await frame(memory.id, organizer.user.id);
  const video = await montage(memory.id, organizer.user.id, { duration_seconds: 90 });
  await stands(video, id, 3);

  const names = async (token: string) =>
    ((await info(app, token, memory.id, id)).json() as Sheet).montages.map((line) => line.name);
  const listed = async (token: string) => {
    const list = await app.inject(
      as(token, { method: "GET", url: `/memories/${memory.id}/montages` }),
    );
    expect(list.statusCode).toBe(200);
    return (list.json() as { id: string; name: string }[]).map((one) => one.name);
  };

  // Nobody has named it: it is its length, in each reader's own language.
  const english = await app.inject(
    as(mark.token, { method: "POST", url: "/me/language", payload: { language: "en" } }),
  );
  expect(english.statusCode).toBe(200);
  expect(await names(organizer.token)).toEqual(["Ролик на 1:30"]);
  expect(await names(mark.token)).toEqual(["Movie of 1:30"]);

  // Renamed — the sheet says the new name, the very one the list says.
  const renamed = await app.inject(
    as(organizer.token, {
      method: "PATCH",
      url: `/memories/${memory.id}/montages/${video}`,
      payload: { name: "Свадьба Марка" },
    }),
  );
  expect(renamed.statusCode).toBe(200);
  for (const token of [organizer.token, mark.token]) {
    expect(await names(token)).toEqual(["Свадьба Марка"]);
    expect(await names(token)).toEqual(await listed(token));
  }

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

test("a NUL in the file name is cut out and a name of nothing is no name, not a 500", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  const intent = (file_name: string) =>
    app.inject(
      as(organizer.token, {
        method: "POST",
        url: `/memories/${memory.id}/media`,
        payload: { kind: "photo", size_bytes: 4096, file_name },
      }),
    );

  // No `text` column holds a NUL, so it is stripped rather than refused; what
  // is left is trimmed, and nothing left is not a name.
  const cases: [string, string | null][] = [
    ["IM\u0000G 4471.HEIC", "IMG 4471.HEIC"],
    ["  IMG_0001.HEIC  ", "IMG_0001.HEIC"],
    ["\u0000 \u0000", null],
    ["", null],
  ];
  for (const [sent, kept] of cases) {
    const asked = await intent(sent);
    expect(asked.statusCode).toBe(201);
    const { id } = asked.json() as { id: string };
    const [stored] = await sql<{ file_name: string | null }[]>`
      select file_name from media_items where id = ${id}
    `;
    expect(stored?.file_name).toBe(kept);
    // Releases the multipart upload the intent started in the store.
    await app.inject(
      as(organizer.token, { method: "DELETE", url: `/memories/${memory.id}/media/${id}` }),
    );
  }

  // A caption, not a payload: past what a filesystem holds it is the client's
  // bug, refused before anything is written.
  expect((await intent("a".repeat(256))).statusCode).toBe(400);
  const longest = await intent("a".repeat(255));
  expect(longest.statusCode).toBe(201);
  await app.inject(
    as(organizer.token, {
      method: "DELETE",
      url: `/memories/${memory.id}/media/${(longest.json() as { id: string }).id}`,
    }),
  );

  await app.close();
});

test("the sheet opens over every frame the gallery shows, finished or not, and counts only this memory's", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const elsewhere = await createMemory(app, organizer.token);
  const mark = await member(app, memory.id, "contributor", organizer.user.id);

  // The gallery lists all three, and draws a placeholder for the last two: the
  // sheet opens over whatever the app is showing, so «only ready» is not a rule
  // it may have.
  const shown = {
    ready: await frame(memory.id, mark.user.id),
    processing: await frame(memory.id, mark.user.id, { status: "processing" }),
    failed: await frame(memory.id, mark.user.id, { status: "failed" }),
  };
  // The same person's frames in another memory of theirs are not «всего кадров»
  // in this one: the tally is per memory, as the roster's is.
  await frame(elsewhere.id, mark.user.id);
  await frame(elsewhere.id, mark.user.id);

  // Read by the contributor, who is neither the organizer nor a viewer.
  for (const [status, id] of Object.entries(shown)) {
    const read = await info(app, mark.token, memory.id, id);
    expect(read.statusCode, status).toBe(200);
    const sheet = read.json() as Sheet;
    expect(sheet.id).toBe(id);
    expect(sheet.uploaded_by.media_count).toBe(3);
  }

  await app.close();
});

test("a frame that stands twice in one video is listed twice, and a finished video with no length is still a line", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const id = await frame(memory.id, organizer.user.id);

  const cut = await montage(memory.id, organizer.user.id, {
    duration_seconds: 60,
    created_at: "2026-09-19T12:00:00Z",
  });
  // Written out of order: the order the sheet answers in is the video's, not
  // the worker's order of insert.
  await stands(cut, id, 40);
  await stands(cut, id, 5.5);
  // A finished video the worker never wrote a length for is a line with a null,
  // not a hole in the answer.
  const unmeasured = await montage(memory.id, organizer.user.id, {
    created_at: "2026-09-20T12:00:00Z",
  });
  await sql`update montages set duration_seconds = null where id = ${unmeasured}`;
  await stands(unmeasured, id, 1);
  // Not finished, however far along: nobody can open these from the sheet.
  for (const status of ["queued", "processing"] as const) {
    await stands(await montage(memory.id, organizer.user.id, { status }), id, 2);
  }

  const read = await info(app, organizer.token, memory.id, id);
  expect(read.statusCode).toBe(200);
  expect((read.json() as Sheet).montages).toEqual([
    { id: unmeasured, name: "Ролик на 0:00", duration_seconds: null, start_seconds: 1 },
    { id: cut, name: "Ролик на 1:00", duration_seconds: 60, start_seconds: 5.5 },
    { id: cut, name: "Ролик на 1:00", duration_seconds: 60, start_seconds: 40 },
  ]);

  await app.close();
});

test("a frame deleted, or carried out by the person who brought it, leaves the layout of the videos with it and the videos stay", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const mark = await member(app, memory.id, "contributor", organizer.user.id);

  const mine = await frame(memory.id, organizer.user.id);
  const deleted = await frame(memory.id, mark.user.id);
  const carried = await frame(memory.id, mark.user.id);
  const video = await montage(memory.id, organizer.user.id);
  await stands(video, mine, 0);
  await stands(video, deleted, 3);
  await stands(video, carried, 6);

  const placed = async () =>
    (
      await sql<{ media_id: string }[]>`
        select media_id from montage_frames where montage_id = ${video} order by start_seconds
      `
    ).map((row) => row.media_id);
  expect(await placed()).toEqual([mine, deleted, carried]);

  // One record, by its owner. A layout row that stayed would point at nothing —
  // and, with a foreign key and no cascade, would turn this into a 500.
  const removed = await app.inject(
    as(mark.token, { method: "DELETE", url: `/memories/${memory.id}/media/${deleted}` }),
  );
  expect(removed.statusCode).toBe(200);
  expect(await placed()).toEqual([mine, carried]);

  // Everything a person brought, when they walk out — the other road material
  // leaves a memory by.
  const left = await app.inject(
    as(mark.token, {
      method: "DELETE",
      url: `/memories/${memory.id}/members/${mark.user.id}`,
    }),
  );
  expect(left.statusCode).toBe(200);
  expect(await placed()).toEqual([mine]);

  // A video already cut is left alone, and what stays in it still says so.
  const read = await info(app, organizer.token, memory.id, mine);
  expect((read.json() as Sheet).montages).toEqual([
    { id: video, name: "Ролик на 1:00", duration_seconds: 60, start_seconds: 0 },
  ]);

  await app.close();
});

test("the sheet hands out no key of the store and no address, and needs no storage to answer", async () => {
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
  await stands(await montage(memory.id, organizer.user.id), id, 12);

  // The frame's own keys (original, thumbnail, preview, the multipart upload's
  // id) and the person's address are all one `select *` away from the answer;
  // the sheet is exactly the documented fields and nothing beside them.
  const original = process.env.R2_ENDPOINT;
  delete process.env.R2_ENDPOINT;
  try {
    // «Поэтому 503 у этого маршрута не бывает»: nothing is signed, so a store
    // that is not configured is not this route's business.
    const read = await info(app, organizer.token, memory.id, id);
    expect(read.statusCode).toBe(200);
    const sheet = read.json() as Sheet;
    expect(Object.keys(sheet).sort()).toEqual([
      "aperture",
      "camera_model",
      "captured_at",
      "created_at",
      "file_name",
      "focal_length_mm",
      "height",
      "id",
      "latitude",
      "longitude",
      "montages",
      "size_bytes",
      "uploaded_by",
      "width",
    ]);
    expect(Object.keys(sheet.uploaded_by).sort()).toEqual([
      "id",
      "media_count",
      "name",
      "username",
    ]);
    expect(Object.keys(sheet.montages[0] ?? {}).sort()).toEqual([
      "duration_seconds",
      "id",
      "name",
      "start_seconds",
    ]);
  } finally {
    if (original === undefined) delete process.env.R2_ENDPOINT;
    else process.env.R2_ENDPOINT = original;
  }

  await app.close();
});

const edit = (app: App, token: string, memoryId: string, mediaId: string, payload: object) =>
  app.inject(
    as(token, { method: "PATCH", url: `/memories/${memoryId}/media/${mediaId}`, payload }),
  );

const galleryIds = async (app: App, token: string, memoryId: string) => {
  const seen = await app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media` }));
  expect(seen.statusCode).toBe(200);
  return (seen.json() as { id: string }[]).map((item) => item.id);
};

test("a hidden frame stays with the one who brought it and leaves everyone else's gallery and the montage", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const mark = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);

  const hidden = await frame(memory.id, mark.user.id, { captured_at: "2026-09-02T19:00:00+03:00" });
  const kept = await frame(memory.id, mark.user.id, { captured_at: "2026-09-02T20:00:00+03:00" });
  const his = await frame(memory.id, organizer.user.id, {
    captured_at: "2026-09-02T21:00:00+03:00",
  });
  await sql`update media_items set thumbnail_key = original_key where memory_id = ${memory.id}`;

  // Nobody but the one who brought it: not the organizer, not a viewer.
  for (const token of [organizer.token, viewer.token]) {
    expect((await edit(app, token, memory.id, hidden, { hidden: true })).statusCode).toBe(404);
  }
  const hid = await edit(app, mark.token, memory.id, hidden, { hidden: true });
  expect(hid.statusCode).toBe(200);
  expect(hid.json()).toMatchObject({ id: hidden, hidden: true });

  // His own gallery still has it, marked; nobody else's has it at all.
  const own = await app.inject(
    as(mark.token, { method: "GET", url: `/memories/${memory.id}/media` }),
  );
  expect(own.json().map((item: { id: string; hidden: boolean }) => [item.id, item.hidden])).toEqual(
    [
      [hidden, true],
      [kept, false],
      [his, false],
    ],
  );
  for (const token of [organizer.token, viewer.token]) {
    expect(await galleryIds(app, token, memory.id)).toEqual([kept, his]);
    expect((await info(app, token, memory.id, hidden)).statusCode).toBe(404);
    const download = await app.inject(
      as(token, { method: "GET", url: `/memories/${memory.id}/media/${hidden}/download` }),
    );
    expect(download.statusCode).toBe(404);
    const all = await app.inject(
      as(token, { method: "GET", url: `/memories/${memory.id}/media/download` }),
    );
    expect(all.json().map((item: { id: string }) => item.id)).toEqual([kept, his]);
  }
  expect((await info(app, mark.token, memory.id, hidden)).statusCode).toBe(200);

  // The card of the memory is the end of the gallery, and reads the same way.
  const cardOf = async (token: string) => {
    const listed = await app.inject(as(token, { method: "GET", url: "/memories" }));
    return (listed.json() as { id: string; recent_thumbnail_urls: string[] }[]).find(
      (card) => card.id === memory.id,
    );
  };
  expect((await cardOf(organizer.token))?.recent_thumbnail_urls).toHaveLength(2);
  expect((await cardOf(mark.token))?.recent_thumbnail_urls).toHaveLength(3);

  // Out of the montage's material, even named by the organizer as «включить».
  expect(await materialLeft(memory.id, [hidden], [])).toMatchObject({ ready: 2, people: 2 });

  // Not a deletion: shown again, it is back where it was for everyone.
  expect((await edit(app, mark.token, memory.id, hidden, { hidden: false })).statusCode).toBe(200);
  expect(await galleryIds(app, organizer.token, memory.id)).toEqual([hidden, kept, his]);
  expect(await materialLeft(memory.id, [], [])).toMatchObject({ ready: 3 });

  await app.close();
});

test("a hidden frame is counted for the one who brought it alone: the memory's card, the label, the roster and the sheet say what the gallery opens", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const mark = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);

  const hidden = await frame(memory.id, mark.user.id);
  const kept = await frame(memory.id, mark.user.id);
  await frame(memory.id, mark.user.id);
  const his = await frame(memory.id, organizer.user.id);

  // A shared box holding the frame before it was hidden: the link stays, and
  // so does the frame's place in it once it is shown again.
  const boxed = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: `/memories/${memory.id}/labels`,
      payload: { title: "Лучшее", color: 1, shared: true, media_ids: [hidden, kept, his] },
    }),
  );
  expect(boxed.statusCode).toBe(201);
  const best = (boxed.json() as { id: string }).id;
  expect((await edit(app, mark.token, memory.id, hidden, { hidden: true })).statusCode).toBe(200);

  /**
   * Every number a person reads about the frames, next to what the gallery
   * actually opens for them: the whole of it, the box as a filter, and the
   * person as one.
   */
  const counted = async (token: string) => {
    const gallery = await app.inject(
      as(token, { method: "GET", url: `/memories/${memory.id}/media` }),
    );
    expect(gallery.statusCode).toBe(200);
    const items = gallery.json() as { id: string; uploaded_by: string; label_ids: string[] }[];
    const home = await app.inject(as(token, { method: "GET", url: "/memories" }));
    const labels = await app.inject(
      as(token, { method: "GET", url: `/memories/${memory.id}/labels` }),
    );
    const roster = await app.inject(
      as(token, { method: "GET", url: `/memories/${memory.id}/members` }),
    );
    return {
      card: (home.json() as { id: string; media_count: number }[]).find((m) => m.id === memory.id)
        ?.media_count,
      gallery: items.length,
      label: (labels.json() as { id: string; media_count: number }[]).find((l) => l.id === best)
        ?.media_count,
      labelFilter: items.filter((item) => item.label_ids.includes(best)).length,
      member: (roster.json() as { id: string; media_count: number }[]).find(
        (m) => m.id === mark.user.id,
      )?.media_count,
      sheet: ((await info(app, token, memory.id, kept)).json() as Sheet).uploaded_by.media_count,
      memberFilter: items.filter((item) => item.uploaded_by === mark.user.id).length,
    };
  };

  // Everybody else — the organizer too — counts what they can open: the
  // hidden frame is in none of their numbers.
  for (const token of [organizer.token, viewer.token]) {
    expect(await counted(token)).toEqual({
      card: 3,
      gallery: 3,
      label: 2,
      labelFilter: 2,
      member: 2,
      sheet: 2,
      memberFilter: 2,
    });
  }
  // The one who hid it still has it in «Мои кадры», and it is counted there.
  expect(await counted(mark.token)).toEqual({
    card: 4,
    gallery: 4,
    label: 3,
    labelFilter: 3,
    member: 3,
    sheet: 3,
    memberFilter: 3,
  });

  // Shown again, it is back in everybody's numbers.
  expect((await edit(app, mark.token, memory.id, hidden, { hidden: false })).statusCode).toBe(200);
  expect(await counted(organizer.token)).toMatchObject({ card: 4, label: 3, member: 3, sheet: 3 });

  await app.close();
});

test("the one who brought a frame corrects its date and place; the gallery follows the date and the camera does not win the place back", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const mark = await member(app, memory.id, "contributor", organizer.user.id);
  const elsewhere = await createMemory(app, mark.token);

  const wrong = await frame(memory.id, mark.user.id, {
    captured_at: "2026-09-02T19:00:00+03:00",
    latitude: 55.518,
    longitude: 37.53,
  });
  const next = await frame(memory.id, mark.user.id, { captured_at: "2026-09-02T20:00:00+03:00" });
  expect(await galleryIds(app, mark.token, memory.id)).toEqual([wrong, next]);

  const fixed = await edit(app, mark.token, memory.id, wrong, {
    captured_at: "2026-09-02T21:30:00+03:00",
    latitude: 59.94,
    longitude: 30.31,
  });
  expect(fixed.statusCode).toBe(200);
  expect(fixed.json()).toEqual({
    id: wrong,
    hidden: false,
    captured_at: "2026-09-02T18:30:00.000Z",
    latitude: 59.94,
    longitude: 30.31,
  });
  // The gallery is ordered by when a frame was shot — now the corrected time.
  expect(await galleryIds(app, organizer.token, memory.id)).toEqual([next, wrong]);

  // The worker reads the original again — a retry, the daily catch-up — and
  // writes the whole row as it always does. The size lands; the place stays.
  const probe = (id: string) => sql`
    update media_items set width = 4032, height = 3024, latitude = 55.518, longitude = 37.53
    where id = ${id}
  `;
  await probe(wrong);
  const sheet = (await info(app, organizer.token, memory.id, wrong)).json() as Sheet;
  expect(sheet).toMatchObject({ width: 4032, latitude: 59.94, longitude: 30.31 });

  // Cleared by hand is kept cleared, just the same.
  const cleared = await edit(app, mark.token, memory.id, wrong, {
    latitude: null,
    longitude: null,
  });
  expect(cleared.json()).toMatchObject({ latitude: null, longitude: null });
  await probe(wrong);
  expect((await info(app, mark.token, memory.id, wrong)).json()).toMatchObject({
    latitude: null,
    longitude: null,
  });
  // A frame nobody placed by hand is still the camera's to fill in.
  await probe(next);
  expect((await info(app, mark.token, memory.id, next)).json()).toMatchObject({
    latitude: 55.518,
    longitude: 37.53,
  });

  // What is not an edit, or not a whole one.
  for (const payload of [
    {},
    { latitude: 1 },
    { latitude: null, longitude: 5 },
    { latitude: 91, longitude: 0 },
    { captured_at: null },
    { captured_at: "yesterday" },
  ]) {
    expect((await edit(app, mark.token, memory.id, wrong, payload)).statusCode).toBe(400);
  }
  // Not a uuid, never existed, and his own frame asked for through another memory.
  const stray = await frame(elsewhere.id, mark.user.id);
  for (const id of ["not-a-uuid", randomUUID(), stray]) {
    const answer = await edit(app, mark.token, memory.id, id, { hidden: true });
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  await app.close();
});

test("the gallery says which way a frame stands, apart from what kind it is", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const at = (minute: number) => `2026-09-02T19:0${minute}:00+03:00`;

  await frame(memory.id, organizer.user.id, { captured_at: at(1), width: 4032, height: 3024 });
  await frame(memory.id, organizer.user.id, { captured_at: at(2), width: 3024, height: 4032 });
  await frame(memory.id, organizer.user.id, { captured_at: at(3), width: 1080, height: 1080 });
  // Not measured yet.
  await frame(memory.id, organizer.user.id, { captured_at: at(4) });

  const seen = await app.inject(
    as(organizer.token, { method: "GET", url: `/memories/${memory.id}/media` }),
  );
  expect(seen.json().map((item: { orientation: string | null }) => item.orientation)).toEqual([
    "landscape",
    "portrait",
    "square",
    null,
  ]);

  await app.close();
});
