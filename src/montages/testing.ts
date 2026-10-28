import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { expect } from "vitest";
import { type buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";

/**
 * The fixture the montage test files share — the material, the tracks and the
 * calls every one of them makes.
 *
 * Live against the real Postgres, as every test here does. No object store is
 * needed: nothing in this family uploads bytes — the worker does that — so the
 * material is written straight into `media_items` and the signed link is only
 * asked to be a signed link.
 */

export type App = ReturnType<typeof buildTestApp>["app"];

/**
 * Whose rows a file is allowed to clear up. The files run side by side against
 * one live database, so each carries a tag of its own: its people, its
 * memories, and an `afterAll` that takes back exactly those.
 */
export function underTag(tag: string) {
  const email = () => testEmail(tag);
  const titleTag = `${tag}-test`;
  const title = () => `${titleTag} ${randomUUID()}`;
  const mine = `${titleTag} %`;

  const createMemory = async (app: App, token: string) => {
    const created = await app.inject(
      as(token, {
        method: "POST",
        url: "/memories",
        payload: { title: title(), event_start: "2026-09-02T18:00:00+03:00" },
      }),
    );
    expect(created.statusCode).toBe(201);
    return created.json() as { id: string; title: string };
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

  // The queue rows go first: `jobs` belongs to montage, and only the rows this
  // file put there may be taken back out. `media_analysis` names a memory
  // rather than a frame or a video, so it is cleared by the memory's own id.
  const cleanup = async () => {
    await sql`
      delete from jobs where type = 'montage' and ref in (
        select id::text from montages where memory_id in (
          select id from memories where title like ${mine}
        )
      )
    `;
    await sql`
      delete from jobs where type = 'media_analysis' and ref in (
        select id::text from memories where title like ${mine}
      )
    `;
    // The memories go before the people: montages.ordered_by deliberately has no
    // ON DELETE, so a user row cannot leave while a montage of theirs stands.
    await sql`delete from memories where title like ${mine}`;
    await cleanupTestUsers(tag);
    await sql.end();
  };

  return { email, title, createMemory, member, cleanup };
}

export const as = (token: string, options: InjectOptions) => ({
  ...options,
  headers: { authorization: `Bearer ${token}` },
});

/**
 * Material in the memory, written where the upload would have left it. The
 * status is what the order counts on, so it is the argument. Answers with the
 * ids, which is what «включить этот кадр» is said with.
 *
 * Two-minute videos unless asked otherwise, because the length a montage may be
 * ordered at is cut from the material itself: three photos are worth six
 * seconds and would refuse every order in this family that names a minute.
 * Photos, and videos of a given length, are asked for where they are the point.
 */
export async function material(
  memoryId: string,
  uploadedBy: string,
  count: number,
  status: "ready" | "processing" = "ready",
  kind: "photo" | "video" = "video",
  seconds: number | null = 120,
) {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const [row] = await sql<{ id: string }[]>`
      insert into media_items (
        memory_id, uploaded_by, kind, status, original_key, size_bytes, duration_seconds
      )
      values (
        ${memoryId}, ${uploadedBy}, ${kind}, ${status}, ${`originals/${randomUUID()}`}, 4096,
        ${kind === "video" ? seconds : null}
      )
      returning id
    `;
    if (row) ids.push(row.id);
  }
  return ids;
}

/**
 * The отсев's verdict on a frame, written where the worker leaves it
 * (`screening.py`): a reason is «отсеять», `null` is «оставить».
 */
export const screened = (id: string, reason: string | null) => sql`
  update media_items set screening_rejected = ${reason !== null}, screening_reason = ${reason}
  where id = ${id}
`;

/**
 * A track of the organizer's own, written where its upload would have left it
 * (`music.ts`); answers with the key the order names it by.
 */
export async function track(
  memoryId: string,
  uploadedBy: string,
  status: "ready" | "pending_upload" = "ready",
) {
  const key = `music/${randomUUID()}`;
  await sql`
    insert into music_uploads (memory_id, uploaded_by, status, object_key, size_bytes)
    values (${memoryId}, ${uploadedBy}, ${status}, ${key}, 4096)
  `;
  return key;
}

export const order = (app: App, token: string, memoryId: string, payload?: object) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/montages`,
      ...(payload === undefined ? {} : { payload }),
    }),
  );

/** The same order, asked about instead of placed — «итог перед монтажом». */
export const preview = (app: App, token: string, memoryId: string, payload?: object) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/montages/preview`,
      ...(payload === undefined ? {} : { payload }),
    }),
  );

/**
 * The summary and the order asked the same thing: one code, one body — and when
 * it goes through, the same length. The order is placed for real, so a body
 * that passes leaves a montage behind; the tests count on nothing else.
 */
export async function alike(app: App, token: string, memoryId: string, payload: object) {
  const shown = await preview(app, token, memoryId, payload);
  const placed = await order(app, token, memoryId, payload);
  const context = JSON.stringify(payload);
  if (placed.statusCode === 201) {
    expect(shown.statusCode, context).toBe(200);
    expect(shown.json().target_seconds, context).toBe(placed.json().params.target_seconds);
  } else {
    expect(shown.statusCode, context).toBe(placed.statusCode);
    expect(shown.json(), context).toEqual(placed.json());
  }
  return placed;
}

export const list = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/montages` }));

export const retry = (app: App, token: string, memoryId: string, montageId: string) =>
  app.inject(
    as(token, { method: "POST", url: `/memories/${memoryId}/montages/${montageId}/retry` }),
  );

/** «Переименовать» — a blank name hands the video back to its default label. */
export const rename = (
  app: App,
  token: string,
  memoryId: string,
  montageId: string,
  name: string,
) =>
  app.inject(
    as(token, {
      method: "PATCH",
      url: `/memories/${memoryId}/montages/${montageId}`,
      payload: { name },
    }),
  );

/** «Удалить ролик». */
export const removeMontage = (app: App, token: string, memoryId: string, montageId: string) =>
  app.inject(as(token, { method: "DELETE", url: `/memories/${memoryId}/montages/${montageId}` }));

/** The screen's own knock — «я открыл готовый ролик» (`watched.ts`). */
export const markWatched = (app: App, token: string, memoryId: string, montageId: string) =>
  app.inject(
    as(token, { method: "POST", url: `/memories/${memoryId}/montages/${montageId}/watched` }),
  );

/** Who has watched a montage and when they first did, straight from the table `watched.ts` writes. */
export const watchesOf = (montageId: string) =>
  sql<{ user_id: string; watched_at: Date }[]>`
    select user_id, watched_at from montage_watches
    where montage_id = ${montageId} order by watched_at
  `;

/** How much layout the worker left behind for a montage — cleared by a delete along with everything else. */
export const layoutOf = async (montageId: string) => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from montage_frames where montage_id = ${montageId}
  `;
  return row?.n ?? 0;
};

export const speak = (app: App, token: string, language: "ru" | "en") =>
  app.inject(as(token, { method: "POST", url: "/me/language", payload: { language } }));

/** «Как собирался» — the journal route, asked here about what retry left it. */
export const journal = (app: App, token: string, memoryId: string, montageId: string) =>
  app.inject(
    as(token, { method: "GET", url: `/memories/${memoryId}/montages/${montageId}/journal` }),
  );

/** The worker's knock. `secret` absent means it knocks with no header at all. */
export const knock = (app: App, montageId: string, secret?: string) =>
  app.inject({
    method: "POST",
    url: `/internal/montages/${montageId}/ready`,
    ...(secret === undefined ? {} : { headers: { authorization: `Bearer ${secret}` } }),
  });

/** The queued jobs pointing at this montage — the worker's whole side of it. */
export const jobsFor = async (montageId: string) =>
  sql<{ type: string; status: string }[]>`
    select type, status from jobs where ref = ${montageId}
  `;

export const montageRows = async (memoryId: string) =>
  sql<
    { id: string; status: string }[]
  >`select id, status from montages where memory_id = ${memoryId}`;

/** What the order is counted in: the memory's tally and the orderer's. */
export const counters = async (memoryId: string, userId: string) => {
  const [memory] = await sql<{ montage_count: number }[]>`
    select montage_count from memories where id = ${memoryId}
  `;
  const [user] = await sql<{ montage_count: number }[]>`
    select montage_count from user_usage where user_id = ${userId}
  `;
  return { memory: memory?.montage_count, user: user?.montage_count ?? 0 };
};

/**
 * The worker's half of a finished video, written by hand — it is not running.
 *
 * `poster` false is a ready video with no poster beside it: everything
 * assembled before the worker learned to cut a frame stays like this forever,
 * and the app has to read it as «постера нет», not as «ещё не готово».
 */
export const assembled = (montageId: string, poster = true) => sql`
  update montages
  set status = 'ready', video_key = ${`montages/${montageId}.mp4`},
      poster_key = ${poster ? `montages/${montageId}.jpg` : null},
      duration_seconds = 58.5, updated_at = now()
  where id = ${montageId}
`;

export const fell = (montageId: string) => sql`
  update montages set status = 'failed', error_text = 'ffmpeg said no', updated_at = now()
  where id = ${montageId}
`;

/** The worker has picked the job up and is at it. */
export const running = (montageId: string) => sql`
  update montages set status = 'processing', updated_at = now() where id = ${montageId}
`;

/**
 * A stage row, as the worker lays it down when it reaches that stage — the
 * only hand that ever writes one (`montage_stages`, миграция 130).
 */
export const stage = (montageId: string, key: string, state: string) => sql`
  insert into montage_stages (montage_id, stage, state) values (${montageId}, ${key}, ${state})
  on conflict (montage_id, stage) do update set state = ${state}, updated_at = now()
`;

/** A line the worker said while it was at this montage, written by its hand. */
export const said = (montageId: string, key: string, thought: string) => sql`
  insert into montage_journal_entries (montage_id, stage, thought)
  values (${montageId}, ${key}, ${thought})
`;

/** How much of the journal stands behind this montage — lines and stages. */
export const journalOf = async (montageId: string) => {
  const [row] = await sql<{ lines: number; stages: number }[]>`
    select
      (select count(*)::int from montage_journal_entries where montage_id = ${montageId}) as lines,
      (select count(*)::int from montage_stages where montage_id = ${montageId}) as stages
  `;
  return row;
};

/** Who the journal counts as watching this montage right now. */
export const watching = async (montageId: string) => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from montage_viewers where montage_id = ${montageId}
  `;
  return row?.n ?? 0;
};
