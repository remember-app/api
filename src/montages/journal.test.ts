import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";

/**
 * Live against the real Postgres, as every test here does, and against no
 * object store at all: the journal moves no bytes — the worker does — so the
 * four storage settings are stood in for right here. Signing is a local HMAC,
 * so a link asked of these is a real signed link and nothing is ever fetched.
 * Each test file runs in its own process, so this is nobody else's environment.
 */
process.env.R2_ENDPOINT = "http://journal.test:9000";
process.env.R2_BUCKET = "journal-test";
process.env.R2_ACCESS_KEY_ID = "journal";
process.env.R2_SECRET_ACCESS_KEY = "journal-secret";

const email = () => testEmail("task200");
const titleTag = "task200-test";
const title = () => `${titleTag} ${randomUUID()}`;
const mine = `${titleTag} %`;

// The queue rows go first: `jobs` belongs to montage, and only the rows this
// file put there may be taken back out. The journal itself needs no line here
// — it hangs off `montages`, which hangs off the memories below.
afterAll(async () => {
  await sql`
    delete from jobs where ref in (
      select id::text from montages where memory_id in (
        select id from memories where title like ${mine}
      )
    )
  `;
  await sql`delete from memories where title like ${mine}`;
  await cleanupTestUsers("task200");
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

/** Material, written where the upload would have left it, with a thumbnail. */
async function material(memoryId: string, uploadedBy: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into media_items (
      memory_id, uploaded_by, kind, status, original_key, thumbnail_key,
      size_bytes, captured_at, duration_seconds
    )
    values (
      ${memoryId}, ${uploadedBy}, 'video', 'ready', ${`originals/${randomUUID()}`},
      ${`thumbs/${randomUUID()}.jpg`}, 4096, '2026-09-13T16:42:00+03:00', 12.5
    )
    returning id
  `;
  if (!row) throw new Error("no media row");
  return row.id;
}

/** A montage of that memory, written where the order route would leave it. */
async function montage(memoryId: string, orderedBy: string, status = "processing") {
  const [row] = await sql<{ id: string }[]>`
    insert into montages (memory_id, ordered_by, status)
    values (${memoryId}, ${orderedBy}, ${status})
    returning id
  `;
  if (!row) throw new Error("no montage row");
  return row.id;
}

/** A stage row, as the worker lays it down when it gets to that stage. */
const stage = (montageId: string, key: string, fields: Record<string, unknown> = {}) =>
  sql`
    insert into montage_stages ${sql({ montage_id: montageId, stage: key, ...fields })}
    on conflict (montage_id, stage) do update set ${sql(fields)}
  `;

/** A row of the layout, as the worker writes it while it cuts the video. */
const place = (montageId: string, mediaId: string, start: number, duration: number) =>
  sql`
    insert into montage_frames (montage_id, media_id, start_seconds, duration_seconds)
    values (${montageId}, ${mediaId}, ${start}, ${duration})
  `;

/** One line of the journal, as the worker appends it. Answers with its id. */
async function entry(montageId: string, fields: Record<string, unknown>) {
  const [row] = await sql<{ id: string }[]>`
    insert into montage_journal_entries ${sql({ montage_id: montageId, ...fields })}
    returning id
  `;
  if (!row) throw new Error("no journal row");
  return Number(row.id);
}

type Journal = {
  montage: { id: string; status: string };
  stages: {
    stage: string;
    state: string;
    eta_seconds: number | null;
    done_count: number;
    total_count: number | null;
    outcome: Record<string, unknown>;
    taken_count: number;
    skipped_count: number;
    thought_count: number;
  }[];
  entries: {
    id: number;
    stage: string;
    media_id: string | null;
    thought: string | null;
    decision: string | null;
    reason: string | null;
    series_size: number | null;
    story_part: number | null;
    story_part_title: string | null;
    source_from_seconds: number | null;
    source_to_seconds: number | null;
    labels: string[] | null;
    focus: { x: number; y: number; w: number; h: number } | null;
  }[];
  has_more: boolean;
  files: {
    id: string;
    kind: string;
    uploaded_by: string;
    captured_at: string | null;
    duration_seconds: number | null;
    thumbnail_url: string | null;
    places: { start_seconds: number; duration_seconds: number }[];
  }[];
  viewers: { id: string; username: string | null }[];
};

const read = (app: App, token: string, memoryId: string, montageId: string, query = "") =>
  app.inject(
    as(token, {
      method: "GET",
      url: `/memories/${memoryId}/montages/${montageId}/journal${query}`,
    }),
  );

const journal = async (app: App, token: string, memoryId: string, montageId: string, q = "") => {
  const answer = await read(app, token, memoryId, montageId, q);
  expect(answer.statusCode).toBe(200);
  return answer.json() as Journal;
};

test("любой участник читает журнал; чужой и несуществующий ролик — один 404", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());

  const id = await montage(memory.id, organizer.user.id);
  await stage(id, "screening", { state: "done", done_count: 214, total_count: 214 });
  await entry(id, { stage: "screening", thought: "Смотрю материал" });

  // Зритель читает наравне с организатором: матрица даёт ему «смотреть ролики».
  for (const token of [organizer.token, contributor.token, viewer.token]) {
    const answer = await journal(app, token, memory.id, id);
    expect(answer.montage).toEqual({ id, status: "processing" });
    expect(answer.entries).toHaveLength(1);
  }

  // Посторонний, чужой ролик, несуществующий и не-uuid — один ответ на всех.
  const elsewhere = await createMemory(app, organizer.token);
  const foreign = await montage(elsewhere.id, organizer.user.id);
  for (const [token, memoryId, montageId] of [
    [stranger.token, memory.id, id],
    [organizer.token, memory.id, foreign],
    [organizer.token, memory.id, randomUUID()],
    [organizer.token, memory.id, "not-a-uuid"],
    [organizer.token, randomUUID(), id],
  ] as const) {
    const answer = await read(app, token, memoryId, montageId);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  expect(
    (await app.inject({ method: "GET", url: `/memories/${memory.id}/montages/${id}/journal` }))
      .statusCode,
  ).toBe(401);

  await app.close();
});

test("этапы идут по порядку пайплайна, со своими счётчиками и итогами", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const id = await montage(memory.id, organizer.user.id);

  // Заведены вразнобой — порядок в ответе задаёт пайплайн, а не воркер.
  await stage(id, "directing", {
    state: "running",
    eta_seconds: 480,
    done_count: 61,
    total_count: 212,
    outcome: sql.json({ parts: 3 }),
  });
  await stage(id, "screening", {
    state: "done",
    done_count: 214,
    total_count: 214,
    outcome: sql.json({ kept: 212, of: 214 }),
  });

  await entry(id, { stage: "screening", decision: "skip", reason: "blur" });
  await entry(id, { stage: "directing", decision: "take", story_part: 2 });
  await entry(id, { stage: "directing", decision: "take", series_size: 4 });
  await entry(id, { stage: "directing", decision: "skip", reason: "duplicate" });
  await entry(id, { stage: "directing", thought: "План: три части" });

  const answer = await journal(app, organizer.token, memory.id, id);
  expect(answer.stages.map((s) => s.stage)).toEqual(["screening", "directing"]);
  expect(answer.stages[0]).toMatchObject({
    state: "done",
    done_count: 214,
    total_count: 214,
    outcome: { kept: 212, of: 214 },
    taken_count: 0,
    skipped_count: 1,
    thought_count: 0,
  });
  // «Взял / мимо / мысли» считает api по записям: чистая мысль — та, у которой
  // решения нет вовсе.
  expect(answer.stages[1]).toMatchObject({
    state: "running",
    eta_seconds: 480,
    done_count: 61,
    total_count: 212,
    outcome: { parts: 3 },
    taken_count: 2,
    skipped_count: 1,
    thought_count: 1,
  });

  await app.close();
});

test("записи идут порциями от курсора, свежие сверху, и сужаются до этапа и файла", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const mediaId = await material(memory.id, organizer.user.id);
  const id = await montage(memory.id, organizer.user.id);

  const ids: number[] = [];
  for (let n = 0; n < 7; n++) {
    ids.push(
      await entry(id, {
        stage: n < 3 ? "screening" : "directing",
        thought: `мысль ${n}`,
        ...(n === 6 ? { media_id: mediaId } : {}),
      }),
    );
  }

  // Свежие сверху, и лишняя запись сверх лимита — это и есть «есть ещё».
  const first = await journal(app, organizer.token, memory.id, id, "?limit=3");
  expect(first.entries.map((e) => e.id)).toEqual([ids[6], ids[5], ids[4]]);
  expect(first.has_more).toBe(true);

  // Назад по журналу — от самой старой показанной.
  const older = await journal(app, organizer.token, memory.id, id, `?limit=3&before=${ids[4]}`);
  expect(older.entries.map((e) => e.id)).toEqual([ids[3], ids[2], ids[1]]);
  expect(older.has_more).toBe(true);
  const oldest = await journal(app, organizer.token, memory.id, id, `?limit=3&before=${ids[1]}`);
  expect(oldest.entries.map((e) => e.id)).toEqual([ids[0]]);
  expect(oldest.has_more).toBe(false);

  // Вперёд: что легло с прошлого опроса, и ничего, пока не легло.
  expect((await journal(app, organizer.token, memory.id, id, `?after=${ids[6]}`)).entries).toEqual(
    [],
  );
  const tail = await journal(app, organizer.token, memory.id, id, `?after=${ids[4]}`);
  expect(tail.entries.map((e) => e.id)).toEqual([ids[6], ids[5]]);

  // И вперёд без дыр, когда легло больше лимита. Клиент двигает курсор на
  // наибольший id порции, так что порция обязана быть ближайшей к курсору, а
  // не самой свежей: иначе всё между курсором и самой старой показанной он не
  // запросит уже никогда, и узнать об этом ему неоткуда.
  const walked: number[] = [];
  let cursor = ids[0];
  for (const [expected, more] of [
    [[ids[2], ids[1]], true],
    [[ids[4], ids[3]], true],
    // Последняя порция полна ровно до лимита, и «есть ещё» гаснет на ней же.
    [[ids[6], ids[5]], false],
  ] as const) {
    const chunk = await journal(app, organizer.token, memory.id, id, `?after=${cursor}&limit=2`);
    expect(chunk.entries.map((e) => e.id)).toEqual(expected);
    // Есть ещё — приложению не ждать следующего опроса, а спросить сразу.
    expect(chunk.has_more).toBe(more);
    walked.push(...chunk.entries.map((e) => e.id));
    cursor = Math.max(...chunk.entries.map((e) => e.id));
  }
  // Пройдено всё, что было новее исходного курсора, — ни одной потерянной.
  expect([...walked].sort((a, b) => a - b)).toEqual(ids.slice(1));
  expect(
    (await journal(app, organizer.token, memory.id, id, `?after=${cursor}&limit=2`)).has_more,
  ).toBe(false);

  // Сужение едет вместе с курсором: тем же шагом, но по одному этапу.
  const staged = await journal(
    app,
    organizer.token,
    memory.id,
    id,
    `?after=${ids[0]}&stage=screening&limit=1`,
  );
  expect(staged.entries.map((e) => e.id)).toEqual([ids[1]]);
  expect(staged.has_more).toBe(true);
  const stagedNext = await journal(
    app,
    organizer.token,
    memory.id,
    id,
    `?after=${ids[1]}&stage=screening&limit=1`,
  );
  expect(stagedNext.entries.map((e) => e.id)).toEqual([ids[2]]);
  expect(stagedNext.has_more).toBe(false);

  // Сужения: один этап и один файл.
  const stageOnly = await journal(app, organizer.token, memory.id, id, "?stage=screening");
  expect(stageOnly.entries.map((e) => e.id)).toEqual([ids[2], ids[1], ids[0]]);
  const fileOnly = await journal(app, organizer.token, memory.id, id, `?media_id=${mediaId}`);
  expect(fileOnly.entries.map((e) => e.id)).toEqual([ids[6]]);

  // Сужение неизвестным этапом — отказ схемы, а не молча пустой журнал.
  expect((await read(app, organizer.token, memory.id, id, "?stage=nonsense")).statusCode).toBe(400);
  // Курсор за пределами bigint — тоже отказ схемы, а не 500 из базы.
  for (const cursor of ["after=10000000000000000000", "before=1e21"]) {
    expect((await read(app, organizer.token, memory.id, id, `?${cursor}`)).statusCode).toBe(400);
  }

  await app.close();
});

test("запись несёт всё, что режиссёр сказал, а сведения о файле — только про эту порцию", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const shown = await material(memory.id, organizer.user.id);
  const elsewhere = await material(memory.id, organizer.user.id);
  const id = await montage(memory.id, organizer.user.id);

  await entry(id, { stage: "directing", media_id: elsewhere, decision: "skip" });
  await entry(id, {
    stage: "directing",
    media_id: shown,
    thought: "Марк роняет кольцо — беру 3 секунды",
    decision: "take",
    series_size: 4,
    story_part: 2,
    story_part_title: "Клятвы и объятия",
    source_from_seconds: 4,
    source_to_seconds: 7,
    labels: ["Бабушка", "смех"],
    focus_x: 0.3,
    focus_y: 0.05,
    focus_w: 0.25,
    focus_h: 0.5,
  });

  const answer = await journal(app, organizer.token, memory.id, id, "?limit=1");
  expect(answer.entries[0]).toMatchObject({
    stage: "directing",
    media_id: shown,
    thought: "Марк роняет кольцо — беру 3 секунды",
    decision: "take",
    series_size: 4,
    story_part: 2,
    story_part_title: "Клятвы и объятия",
    source_from_seconds: 4,
    source_to_seconds: 7,
    labels: ["Бабушка", "смех"],
    focus: { x: 0.3, y: 0.05, w: 0.25, h: 0.5 },
  });
  // Ровно контракт: ролик, про который и так спросили, в каждой записи не едет.
  expect(answer.entries[0]).not.toHaveProperty("montage_id");

  // Только файл из отданной порции — второй в неё не попал.
  expect(answer.files).toHaveLength(1);
  const [file] = answer.files;
  expect(file).toMatchObject({
    id: shown,
    kind: "video",
    uploaded_by: organizer.user.id,
    duration_seconds: 12.5,
  });
  expect(file?.captured_at).toBe("2026-09-13T13:42:00.000Z");
  // Миниатюра уходит подписанной ссылкой, как в галерее, и никогда ключом.
  const [key] = await sql<{ thumbnail_key: string }[]>`
    select thumbnail_key from media_items where id = ${shown}
  `;
  const url = new URL(file?.thumbnail_url ?? "");
  expect(url.pathname).toContain(key?.thumbnail_key);
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  expect(url.searchParams.get("X-Amz-Expires")).toBe("900");

  await app.close();
});

test("у файла видно, где он лёг в ролике; не вошёл или раскладки нет — пусто", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const twice = await material(memory.id, organizer.user.id);
  const once = await material(memory.id, organizer.user.id);
  const cut = await material(memory.id, organizer.user.id);
  const id = await montage(memory.id, organizer.user.id);
  const neighbour = await montage(memory.id, organizer.user.id);

  for (const mediaId of [twice, once, cut]) {
    await entry(id, {
      stage: "rhythm",
      media_id: mediaId,
      decision: mediaId === cut ? "skip" : "take",
    });
  }
  // Клип, разрезанный надвое, законно стоит в ролике дважды — оба места видны.
  await place(id, twice, 12.5, 3);
  await place(id, twice, 0, 2.25);
  await place(id, once, 5.5, 1.5);
  // Раскладка соседнего ролика сюда не течёт, даже про тот же кадр.
  await place(neighbour, cut, 1, 1);

  const answer = await journal(app, organizer.token, memory.id, id);
  const places = (mediaId: string) => answer.files.find((f) => f.id === mediaId)?.places;
  // По порядку в ролике, а не в том, в котором воркер их записал.
  expect(places(twice)).toEqual([
    { start_seconds: 0, duration_seconds: 2.25 },
    { start_seconds: 12.5, duration_seconds: 3 },
  ]);
  expect(places(once)).toEqual([{ start_seconds: 5.5, duration_seconds: 1.5 }]);
  // Кадр, в ролик не вошедший, места не имеет — и это не ошибка.
  expect(places(cut)).toEqual([]);

  // Раскладки ещё нет вовсе — то же пустое поле: отсев идёт раньше, чем ролик
  // разложен, и сведения о файле читаются и без мест.
  const fresh = await montage(memory.id, organizer.user.id);
  await entry(fresh, { stage: "screening", media_id: twice, decision: "take" });
  expect((await journal(app, organizer.token, memory.id, fresh)).files[0]).toMatchObject({
    id: twice,
    places: [],
  });

  await app.close();
});

test("пока ролик собирается, чтение и есть «смотрю»; у готового не отмечает никого", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const watcher = await member(app, memory.id, "viewer", organizer.user.id);
  const id = await montage(memory.id, organizer.user.id);

  // Свой же запрос попадает в ответ: экран рисует и себя в числе смотрящих.
  const alone = await journal(app, organizer.token, memory.id, id);
  expect(alone.viewers.map((v) => v.id)).toEqual([organizer.user.id]);

  await journal(app, watcher.token, memory.id, id);
  const both = await journal(app, organizer.token, memory.id, id);
  expect(both.viewers.map((v) => v.id).sort()).toEqual([organizer.user.id, watcher.user.id].sort());

  // Очередь — тоже «собирается»: ждущий ролик смотрят так же.
  const queued = await montage(memory.id, organizer.user.id, "queued");
  expect((await journal(app, organizer.token, memory.id, queued)).viewers).toHaveLength(1);

  // Готовый и упавший не отмечают никого — смотреть за ними уже нечего.
  for (const status of ["ready", "failed"]) {
    const done = await montage(memory.id, organizer.user.id, status);
    expect((await journal(app, organizer.token, memory.id, done)).viewers).toEqual([]);
    const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`
      select count(*)::int from montage_viewers where montage_id = ${done}
    `;
    expect(count).toBe(0);
  }

  await app.close();
});

test("ролика без журнала — пустой ответ, а не ошибка; у готового журнал читается весь", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  // Собран раньше, чем журнал вообще появился, — или ещё стоит в очереди.
  const bare = await montage(memory.id, organizer.user.id, "ready");
  expect(await journal(app, organizer.token, memory.id, bare)).toEqual({
    montage: { id: bare, status: "ready" },
    stages: [],
    entries: [],
    has_more: false,
    files: [],
    viewers: [],
  });

  // Готовый и упавший читаются так же, как идущий: журнал лежит с роликом.
  for (const status of ["ready", "failed"]) {
    const id = await montage(memory.id, organizer.user.id, status);
    await stage(id, "assembly", { state: status === "ready" ? "done" : "failed" });
    await entry(id, { stage: "assembly", thought: "Склеиваю" });
    const answer = await journal(app, organizer.token, memory.id, id);
    expect(answer.stages).toHaveLength(1);
    expect(answer.entries.map((e) => e.thought)).toEqual(["Склеиваю"]);
  }

  await app.close();
});

test("ушёл ролик — ушёл журнал; ушёл кадр — запись о нём осталась", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const mediaId = await material(memory.id, organizer.user.id);
  const id = await montage(memory.id, organizer.user.id);
  await stage(id, "screening", { state: "done" });
  await entry(id, { stage: "screening", media_id: mediaId, decision: "take" });

  // Кадр удалён обычным путём — запись о нём остаётся, просто без сведений.
  const deleted = await app.inject(
    as(organizer.token, { method: "DELETE", url: `/memories/${memory.id}/media/${mediaId}` }),
  );
  expect(deleted.statusCode).toBe(200);
  const after = await journal(app, organizer.token, memory.id, id);
  expect(after.entries[0]).toMatchObject({ media_id: mediaId, decision: "take" });
  expect(after.files).toEqual([]);

  // Ролик удалён — журнал уходит с ним, и не остаётся ни записей, ни этапов,
  // ни смотрящих.
  await sql`delete from montages where id = ${id}`;
  for (const table of ["montage_journal_entries", "montage_stages", "montage_viewers"]) {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int from ${sql(table)} where montage_id = ${id}
    `;
    expect(row?.count).toBe(0);
  }

  await app.close();
});
