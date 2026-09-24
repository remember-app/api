import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "./plugin.ts";

/**
 * `DELETE /memories/:memoryId` (doc-01, 2026-09-24) — the organizer takes a whole
 * memory down, and everything hanging off it goes with it.
 *
 * What is asked here is the two halves of that promise: nothing of this memory
 * is left in any table, in the worker's own tables included — and nothing of the
 * neighbouring memory is touched, which is the whole risk of a statement that
 * deletes by anything other than one id.
 */

const email = () => testEmail("task281");

/** As in memories.test.ts: memories go by title tag, because they do not cascade off users. */
const titleTag = "task281-test";
const title = () => `${titleTag} ${randomUUID()}`;
const tagged = `${titleTag} %`;

afterAll(async () => {
  // The worker's tables hold no foreign key at all (montage `schema.sql`), so
  // the rows these tests write into them are this file's own to sweep — and
  // before the memories they name, which is where the ids come from.
  await sql`
    delete from media_speech where media_id in (
      select mi.id::text from media_items mi
      join memories m on m.id = mi.memory_id where m.title like ${tagged})
  `;
  await sql`
    delete from media_understandings where memory_id in (
      select id::text from memories where title like ${tagged})
  `;
  await sql`
    delete from jobs where ref in (
      select mi.id::text from media_items mi
      join memories m on m.id = mi.memory_id where m.title like ${tagged}
      union all
      select mo.id::text from montages mo
      join memories m on m.id = mo.memory_id where m.title like ${tagged})
  `;
  await sql`delete from memories where title like ${tagged}`;
  await cleanupTestUsers("task281");
  await sql.end();
});

type App = ReturnType<typeof buildTestApp>["app"];

const as = (token: string, options: InjectOptions) => ({
  ...options,
  headers: { authorization: `Bearer ${token}` },
});

const start = "2026-09-02T18:00:00+03:00";

const createMemory = async (app: App, token: string) => {
  const created = await app.inject(
    as(token, {
      method: "POST",
      url: "/memories",
      payload: { title: title(), event_start: start },
    }),
  );
  expect(created.statusCode).toBe(201);
  return created.json();
};

/** Somebody signed in and put into the memory at the standing asked for. */
async function member(app: App, memoryId: string, role: MemberRole, by: string) {
  const person = await signIn(app, email());
  await sql`
    insert into memory_members (memory_id, user_id, role, invited_by)
    values (${memoryId}, ${person.user.id}, ${role}, ${by})
  `;
  return person;
}

const remove = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "DELETE", url: `/memories/${memoryId}` }));

const list = (app: App, token: string) =>
  app.inject(as(token, { method: "GET", url: "/memories" }));

const gallery = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media` }));

/**
 * A memory with something of everything in it: frames of two people (one of
 * them still uploading), a label they are filed in, a live invite link, an
 * assembled video with its journal and its layout, a track the organizer
 * brought, the queue's jobs about all of it, and what the worker wrote down
 * about a frame — a description and a transcript.
 *
 * Written straight into the tables rather than through the routes that fill
 * them: every one of those paths is proven in its own file, and what is asked
 * here is only what a deletion leaves behind.
 */
async function fill(memoryId: string, organizerId: string, contributorId: string) {
  const frame = async (by: string, status: string, bytes: number) => {
    const [row] = await sql<{ id: string }[]>`
      insert into media_items (memory_id, uploaded_by, kind, status, original_key,
                               thumbnail_key, preview_key, upload_id, size_bytes)
      values (${memoryId}, ${by}, 'photo', ${status}, ${`originals/${randomUUID()}`},
              ${`thumbs/${randomUUID()}`}, ${`previews/${randomUUID()}`},
              ${status === "pending_upload" ? randomUUID() : null}, ${bytes})
      returning id
    `;
    if (!row) throw new Error("the fixture wrote no media row");
    return row.id;
  };
  const kept = await frame(organizerId, "ready", 1000);
  const brought = await frame(contributorId, "ready", 500);
  const uploading = await frame(contributorId, "pending_upload", 700);

  // The face of the memory, which most of them have (migration 110): the frame
  // it points at is deleted by the same statement that updates the counters on
  // this very row, and `ON DELETE SET NULL` writes to it a third time.
  await sql`update memories set cover_media_id = ${kept} where id = ${memoryId}`;

  // The tallies as the upload path would have left them, so a deletion that
  // forgets them is visible as a number that never comes back down.
  for (const [who, bytes] of [
    [organizerId, 1000],
    [contributorId, 500],
  ] as const) {
    await sql`
      insert into user_usage (user_id, storage_bytes, upload_count) values (${who}, ${bytes}, 1)
      on conflict (user_id) do update set
        storage_bytes = user_usage.storage_bytes + ${bytes},
        upload_count = user_usage.upload_count + 1
    `;
  }

  const [label] = await sql<{ id: string }[]>`
    insert into labels (memory_id, owner_id, title, color, shared)
    values (${memoryId}, ${organizerId}, 'Коробка', 3, true) returning id
  `;
  if (!label) throw new Error("the fixture wrote no label row");
  await sql`
    insert into label_media (label_id, media_id, memory_id, added_by)
    values (${label.id}, ${kept}, ${memoryId}, ${organizerId})
  `;
  await sql`
    insert into invites (memory_id, token, role, created_by)
    values (${memoryId}, ${randomUUID()}, 'contributor', ${organizerId})
  `;

  const [montage] = await sql<{ id: string }[]>`
    insert into montages (memory_id, ordered_by, status, video_key, poster_key, duration_seconds)
    values (${memoryId}, ${organizerId}, 'ready', ${`montages/${randomUUID()}.mp4`},
            ${`montages/${randomUUID()}.jpg`}, 60)
    returning id
  `;
  if (!montage) throw new Error("the fixture wrote no montage row");
  await sql`
    insert into montage_journal_entries (montage_id, stage, media_id, thought, decision)
    values (${montage.id}, 'screening', ${kept}, 'Беру: на нём все', 'take')
  `;
  await sql`
    insert into montage_stages (montage_id, stage, state) values (${montage.id}, 'screening', 'done')
  `;
  await sql`
    insert into montage_viewers (montage_id, user_id) values (${montage.id}, ${contributorId})
  `;
  await sql`
    insert into montage_frames (montage_id, media_id, start_seconds, duration_seconds)
    values (${montage.id}, ${kept}, 0, 3)
  `;

  await sql`
    insert into music_uploads (memory_id, uploaded_by, status, object_key, upload_id, size_bytes)
    values (${memoryId}, ${organizerId}, 'ready', ${`music/${randomUUID()}`}, null, 400)
  `;
  await sql`
    insert into music_uploads (memory_id, uploaded_by, status, object_key, upload_id, size_bytes)
    values (${memoryId}, ${organizerId}, 'pending_upload', ${`music/${randomUUID()}`},
            ${randomUUID()}, 400)
  `;

  // The queue, as an upload and an order leave it: work about a frame and work
  // about the video.
  for (const [type, ref] of [
    ["media_preview", uploading],
    ["media_understanding", kept],
    ["montage", montage.id],
  ] as const) {
    await sql`insert into jobs (type, ref) values (${type}, ${ref})`;
  }

  // The worker's own two tables: what was said in a clip and what was seen in a
  // frame. Nothing in the database points them at anything, which is why they
  // are here at all.
  await sql`insert into media_speech (media_id, transcript) values (${kept}, 'горько!')`;
  await sql`
    insert into media_understandings (media_id, memory_id, description, cast_labels)
    values (${brought}, ${memoryId}, 'двое у окна', ${sql.array(["человек-1"])})
  `;

  return { mediaIds: [kept, brought, uploading], montageIds: [montage.id] };
}

/** What still stands under the memory itself, by the row that owns it. */
const under = async (memoryId: string) => {
  const [row] = await sql<Record<string, number>[]>`
    select
      (select count(*)::int from memories where id = ${memoryId}) as memories,
      (select count(*)::int from memory_members where memory_id = ${memoryId}) as members,
      (select count(*)::int from invites where memory_id = ${memoryId}) as invites,
      (select count(*)::int from media_items where memory_id = ${memoryId}) as media,
      (select count(*)::int from labels where memory_id = ${memoryId}) as labels,
      (select count(*)::int from label_media where memory_id = ${memoryId}) as label_media,
      (select count(*)::int from montages where memory_id = ${memoryId}) as montages,
      (select count(*)::int from music_uploads where memory_id = ${memoryId}) as music
  `;
  if (!row) throw new Error("a count of one memory answered no row");
  return row;
};

/**
 * And what still stands under ids the memory no longer names — the journals of
 * its videos, the queue's jobs, and the worker's descriptions and transcripts.
 * By id and not by memory, because after the deletion there is no memory left
 * to ask through: a count written the other way round would pass on an empty
 * join while the rows sat there for ever.
 */
const traces = async (mediaIds: string[], montageIds: string[]) => {
  const [row] = await sql<Record<string, number>[]>`
    select
      (select count(*)::int from montage_journal_entries where montage_id in ${sql(montageIds)}) as journal,
      (select count(*)::int from montage_stages where montage_id in ${sql(montageIds)}) as stages,
      (select count(*)::int from montage_viewers where montage_id in ${sql(montageIds)}) as viewers,
      (select count(*)::int from montage_frames where montage_id in ${sql(montageIds)}) as layout,
      (select count(*)::int from jobs where ref in ${sql([...mediaIds, ...montageIds])}) as jobs,
      (select count(*)::int from media_speech where media_id in ${sql(mediaIds)}) as speech,
      (select count(*)::int from media_understandings where media_id in ${sql(mediaIds)}) as described
  `;
  if (!row) throw new Error("a count of one memory's traces answered no row");
  return row;
};

const usageOf = (userId: string) =>
  sql<{ storage_bytes: string; upload_count: number }[]>`
    select storage_bytes, upload_count from user_usage where user_id = ${userId}
  `.then((rows) => rows[0]);

test("the organizer deletes a memory and everything hanging off it goes — the neighbour's does not", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const filled = await fill(memory.id, organizer.user.id, contributor.user.id);

  // A second memory of the same two people, filled exactly the same way: every
  // statement of the deletion has to miss it.
  const neighbour = await createMemory(app, organizer.token);
  await sql`
    insert into memory_members (memory_id, user_id, role, invited_by)
    values (${neighbour.id}, ${contributor.user.id}, 'contributor', ${organizer.user.id})
  `;
  const untouched = await fill(neighbour.id, organizer.user.id, contributor.user.id);

  expect(await under(memory.id)).toEqual({
    memories: 1,
    members: 2,
    invites: 1,
    media: 3,
    labels: 1,
    label_media: 1,
    montages: 1,
    music: 2,
  });
  expect(await traces(filled.mediaIds, filled.montageIds)).toEqual({
    journal: 1,
    stages: 1,
    viewers: 1,
    layout: 1,
    jobs: 3,
    speech: 1,
    described: 1,
  });

  const gone = await remove(app, organizer.token, memory.id);
  expect(gone.statusCode).toBe(200);
  expect(gone.json()).toEqual({ ok: true });

  expect(await under(memory.id)).toEqual({
    memories: 0,
    members: 0,
    invites: 0,
    media: 0,
    labels: 0,
    label_media: 0,
    montages: 0,
    music: 0,
  });
  expect(await traces(filled.mediaIds, filled.montageIds)).toEqual({
    journal: 0,
    stages: 0,
    viewers: 0,
    layout: 0,
    jobs: 0,
    speech: 0,
    described: 0,
  });

  // The tallies come back down to what the neighbouring memory alone holds —
  // not to zero, because that material is still there.
  expect(await usageOf(organizer.user.id)).toEqual({ storage_bytes: "1000", upload_count: 1 });
  expect(await usageOf(contributor.user.id)).toEqual({ storage_bytes: "500", upload_count: 1 });

  // Nothing of the neighbour moved: not its rows, not its journal, not the
  // worker's word about its frames.
  expect(await under(neighbour.id)).toEqual({
    memories: 1,
    members: 2,
    invites: 1,
    media: 3,
    labels: 1,
    label_media: 1,
    montages: 1,
    music: 2,
  });
  expect(await traces(untouched.mediaIds, untouched.montageIds)).toEqual({
    journal: 1,
    stages: 1,
    viewers: 1,
    layout: 1,
    jobs: 3,
    speech: 1,
    described: 1,
  });

  await app.close();
});

test("after the deletion nobody has a ghost of it: not the list, not the gallery, not a second delete", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  await fill(memory.id, organizer.user.id, contributor.user.id);
  const kept = await createMemory(app, organizer.token);

  expect((await list(app, contributor.token)).json().map((one: { id: string }) => one.id)).toEqual([
    memory.id,
  ]);

  expect((await remove(app, organizer.token, memory.id)).statusCode).toBe(200);

  // The member's main screen: it simply is not there any more, and the one
  // they were not in never was.
  expect((await list(app, contributor.token)).json()).toEqual([]);
  expect((await list(app, organizer.token)).json().map((one: { id: string }) => one.id)).toEqual([
    kept.id,
  ]);
  // And every route under it answers as it answers for a memory that never
  // existed — the house 404, from the membership check.
  for (const token of [organizer.token, contributor.token]) {
    const looked = await gallery(app, token, memory.id);
    expect(looked.statusCode).toBe(404);
    expect(looked.json()).toEqual({ error: "not found" });
  }
  expect((await remove(app, organizer.token, memory.id)).statusCode).toBe(404);

  await app.close();
});

test("only the organizer may delete: everybody else is refused and the memory stands", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());
  await fill(memory.id, organizer.user.id, contributor.user.id);

  // A member of another standing is told plainly that it is not theirs to do.
  for (const who of [contributor, viewer]) {
    const refused = await remove(app, who.token, memory.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }
  // A stranger is not told there is anything here at all — the house rule of
  // this family, so nobody can enumerate memories by trying to delete them.
  for (const url of [memory.id, randomUUID(), "not-a-uuid"]) {
    const refused = await remove(app, stranger.token, url);
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({ error: "not found" });
  }

  // Everything is where it was: four refusals moved nothing.
  expect(await under(memory.id)).toMatchObject({ memories: 1, media: 3 });
  expect((await gallery(app, contributor.token, memory.id)).statusCode).toBe(200);

  await app.close();
});

test("the objects are named for the bucket, and a bucket that refuses leaves them in the log", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  await fill(memory.id, organizer.user.id, contributor.user.id);

  const keys = await sql<{ key: string }[]>`
    select original_key as key from media_items where memory_id = ${memory.id}
    union all select thumbnail_key from media_items where memory_id = ${memory.id}
    union all select preview_key from media_items where memory_id = ${memory.id}
    union all select video_key from montages where memory_id = ${memory.id}
    union all select poster_key from montages where memory_id = ${memory.id}
    union all select object_key from music_uploads where memory_id = ${memory.id}
  `;

  // Nothing listens there, so every request is refused at once — the same way
  // the push tests stand a dead host in for a service.
  const previous = process.env.R2_ENDPOINT;
  process.env.R2_ENDPOINT = "http://127.0.0.1:1";
  try {
    expect((await remove(app, organizer.token, memory.id)).statusCode).toBe(200);
  } finally {
    if (previous === undefined) delete process.env.R2_ENDPOINT;
    else process.env.R2_ENDPOINT = previous;
  }

  // The rows are gone whatever the bucket answered — a deletion that reported a
  // failure would say it had not happened when it had.
  expect((await under(memory.id)).memories).toBe(0);
  const complaints = lines
    .map((line) => JSON.parse(line) as { msg?: string; keys?: string[]; uploads?: unknown[] })
    .filter((line) => line.msg === "media records are gone but their objects are not");
  // Two lines and not one: the unfinished uploads and the objects are released
  // by different calls, and a bucket that refuses the first still has to be
  // asked for the second — otherwise one stuck upload keeps every file of a
  // deleted memory in the bucket for ever.
  expect(complaints).toHaveLength(2);
  const logged = complaints.at(-1);
  // Every file of the memory is in that line: the originals and both
  // derivatives of each frame, the video, its cover and the track.
  expect(new Set(logged?.keys)).toEqual(new Set(keys.map((row) => row.key)));
  // And the two uploads nobody finished — a frame's and a track's — which are
  // released differently and so are counted apart.
  expect(logged?.uploads).toHaveLength(2);

  await app.close();
});
