import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";
import { MAX_COMMENT_LENGTH } from "./comments.ts";

/**
 * Комментарии к кадру (doc-14, TASK-497) снаружи, через HTTP. Проверяется ровно то,
 * о чём договорились в карточке и в `docs/media.md`: кто что видит, кто что может
 * написать и снести, и что комментарий уходит вместе с кадром.
 *
 * Чтение проверяется не отдельным маршрутом, а там, где комментарии и живут, — в
 * «Сведениях о кадре»: значит, тест ломается и на том, что поле забыли в ответ
 * вписать, и на том, что вписали не те строки.
 */

const email = () => testEmail("task497");
const titleTag = "task497-test";
const title = () => `${titleTag} ${randomUUID()}`;

afterAll(async () => {
  await sql`delete from memories where title like ${`${titleTag} %`}`;
  await cleanupTestUsers("task497");
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

/** Участник нужного звания, поставленный так, как его поставило бы приглашение. */
async function member(app: App, memoryId: string, role: MemberRole, by: string) {
  const person = await signIn(app, email());
  await sql`
    insert into memory_members (memory_id, user_id, role, invited_by)
    values (${memoryId}, ${person.user.id}, ${role}, ${by})
  `;
  return person;
}

/** Кадр, уже лежащий в воспоминании: статусом и ключом, за которым байтов нет. */
async function frame(
  memoryId: string,
  uploadedBy: string,
  status: "ready" | "pending_upload" = "ready",
) {
  const [row] = await sql<{ id: string }[]>`
    insert into media_items (memory_id, uploaded_by, kind, status, original_key, size_bytes,
      captured_at)
    values (${memoryId}, ${uploadedBy}, 'photo', ${status},
      ${`task497/${randomUUID()}`}, 4096, ${`2026-09-02T19:00:00+03:00`})
    returning id
  `;
  if (!row) throw new Error("insert into media_items returned no row");
  return row.id;
}

const info = (app: App, token: string, memoryId: string, mediaId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media/${mediaId}` }));

const write = (app: App, token: string, memoryId: string, mediaId: string, payload: unknown) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/media/${mediaId}/comments`,
      payload: payload as object,
    }),
  );

const drop = (
  app: App,
  token: string,
  memoryId: string,
  mediaId: string,
  commentId: string,
) =>
  app.inject(
    as(token, {
      method: "DELETE",
      url: `/memories/${memoryId}/media/${mediaId}/comments/${commentId}`,
    }),
  );

/** Что в кадре лежит написано, глазами именно этого участника. */
type Comment = {
  id: string;
  body: string;
  created_at: string;
  author: { id: string; username: string | null; name: string | null };
  mine: boolean;
};

const commentsOf = async (app: App, token: string, memoryId: string, mediaId: string) => {
  const answer = await info(app, token, memoryId, mediaId);
  expect(answer.statusCode).toBe(200);
  return (answer.json() as { comments: Comment[] }).comments;
};

const bodies = (rows: Comment[]) => rows.map((row) => row.body);

/** Сколько строк на самом деле — минуя маршруты, как их видит база. */
const stored = async (mediaId: string) => {
  const rows = await sql<{ id: string }[]>`
    select id from frame_comments where media_id = ${mediaId} order by created_at, id
  `;
  return rows.map((row) => row.id);
};

test("подписи кадра видит любой участник, зритель в том числе, и чужие кадры не текут", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);

  const shown = await frame(memory.id, anna.user.id);
  const bare = await frame(memory.id, organizer.user.id);
  const elsewhere = await createMemory(app, organizer.token);
  const alien = await frame(elsewhere.id, organizer.user.id);

  const first = await write(app, anna.token, memory.id, shown, { body: "Борис и Маша" });
  expect(first.statusCode).toBe(201);
  const second = await write(app, organizer.token, memory.id, shown, { body: "Тут женились" });
  expect(second.statusCode).toBe(201);

  // У организатора обе, в порядке времени, и его собственная помечена как своя.
  const forOrganizer = await commentsOf(app, organizer.token, memory.id, shown);
  expect(bodies(forOrganizer)).toEqual(["Борис и Маша", "Тут женились"]);
  expect(forOrganizer.map((row) => row.mine)).toEqual([false, true]);
  expect(forOrganizer[1]).toEqual({
    id: second.json().id,
    body: "Тут женились",
    created_at: expect.any(String),
    author: { id: organizer.user.id, username: organizer.user.username, name: organizer.user.name },
    mine: true,
  });

  // У участницы — те же обе, «своя» помечена верно: у неё первая.
  expect(bodies(await commentsOf(app, anna.token, memory.id, shown))).toEqual([
    "Борис и Маша",
    "Тут женились",
  ]);
  expect(
    (await commentsOf(app, anna.token, memory.id, shown)).map((row) => row.mine),
  ).toEqual([true, false]);

  // Зритель читает то же самое: подписи видны всем, кто видит кадр.
  expect(bodies(await commentsOf(app, viewer.token, memory.id, shown))).toEqual([
    "Борис и Маша",
    "Тут женились",
  ]);

  // Кадр без подписей — пустой список, а не пропавший ключ и не 404.
  const empty = await commentsOf(app, organizer.token, memory.id, bare);
  expect(empty).toEqual([]);
  expect("comments" in (await info(app, organizer.token, memory.id, bare)).json()).toBe(true);

  await app.close();
});

test("зритель пишет и сносит своё — он участник воспоминания, а не гость", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const id = await frame(memory.id, organizer.user.id);

  const written = await write(app, viewer.token, memory.id, id, { body: "Я тут стоял" });
  expect(written.statusCode).toBe(201);
  const commentId = written.json().id as string;
  expect(written.json().mine).toBe(true);
  expect((await commentsOf(app, organizer.token, memory.id, id))[0]).toEqual({
    id: commentId,
    body: "Я тут стоял",
    created_at: expect.any(String),
    author: {
      id: viewer.user.id,
      username: viewer.user.username,
      name: viewer.user.name,
    },
    mine: false,
  });

  // Свой комментарий зритель сносит, и после этого под кадром пусто.
  const removed = await drop(app, viewer.token, memory.id, id, commentId);
  expect(removed.statusCode).toBe(200);
  expect(removed.json()).toEqual({ ok: true });
  expect(await commentsOf(app, viewer.token, memory.id, id)).toEqual([]);

  await app.close();
});

test("чужой комментарий не сносит никто, включая организатора", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const boris = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);

  const id = await frame(memory.id, organizer.user.id);
  const annas = await write(app, anna.token, memory.id, id, { body: "Моё" });
  expect(annas.statusCode).toBe(201);
  const annasId = annas.json().id as string;

  // Организатор управляет кадрами, но не чужими словами: у него `403` нет даже на
  // попытку. И отказ не выдаёт, что строка была: «нельзя» было бы ответом о том,
  // что она есть.
  for (const token of [organizer.token, boris.token, viewer.token]) {
    const refused = await drop(app, token, memory.id, id, annasId);
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toBe('{"error":"not found"}');
  }
  // Строка на месте — отказ ничего не сделал.
  expect(await stored(id)).toEqual([annasId]);

  // Снести второй раз — тоже «нет такого», как и несуществующий или кривой id.
  await drop(app, anna.token, memory.id, id, annasId);
  for (const bad of [annasId, randomUUID(), "not-a-uuid"]) {
    const answer = await drop(app, anna.token, memory.id, id, bad);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }

  await app.close();
});

test("удаление кадра уносит его комментарии, а кадры других не трогает", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const elsewhere = await createMemory(app, organizer.token);

  const doomed = await frame(memory.id, anna.user.id);
  const survivor = await frame(memory.id, organizer.user.id);
  const other = await frame(memory.id, organizer.user.id);
  for (const target of [doomed, survivor, other]) {
    const written = await write(app, organizer.token, memory.id, target, { body: "Подпись" });
    expect(written.statusCode).toBe(201);
  }
  // Кадр соседнего воспоминания подписать нельзя — он не в этом воспоминании.
  const alien = await frame(elsewhere.id, organizer.user.id);
  expect((await write(app, organizer.token, memory.id, alien, { body: "Чужая" })).statusCode).toBe(
    404,
  );

  // Удалённый кадр уносит свои подписи каскадом, остальные не трогает.
  const removed = await app.inject(
    as(organizer.token, { method: "DELETE", url: `/memories/${memory.id}/media/${doomed}` }),
  );
  expect(removed.statusCode).toBe(200);
  expect(await stored(doomed)).toEqual([]);
  expect(await stored(survivor)).toHaveLength(1);
  expect(await stored(other)).toHaveLength(1);
  expect(await stored(alien)).toEqual([]);

  await app.close();
});

test("чужой кадр, несуществующий и кривой id — один 404 на любую запись", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const stranger = await signIn(app, email());
  const elsewhere = await createMemory(app, organizer.token);
  const id = await frame(memory.id, organizer.user.id);
  const alien = await frame(elsewhere.id, organizer.user.id);
  const commentId = (await write(app, organizer.token, memory.id, id, { body: "Своя" })).json()
    .id as string;

  for (const bad of [alien, randomUUID(), "not-a-uuid"]) {
    const answer = await write(app, organizer.token, memory.id, bad, { body: "Чужая" });
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
    const removed = await drop(app, organizer.token, memory.id, bad, commentId);
    expect(removed.statusCode).toBe(404);
  }
  expect(await stored(id)).toEqual([commentId]);

  // Не участник воспоминания не пишет и не сносит ничего.
  for (const answer of [
    await write(app, stranger.token, memory.id, id, { body: "Влез" }),
    await drop(app, stranger.token, memory.id, id, commentId),
  ]) {
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  // Без сессии — 401, и тело у него своё, не «not found».
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/memories/${memory.id}/media/${id}/comments`,
        payload: { body: "Без токена" },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/memories/${memory.id}/media/${id}/comments/${commentId}`,
      })
    ).statusCode,
  ).toBe(401);

  await app.close();
});

test("скрытый кадр уносит свои подписи у всех, кроме того, кто его скрыл", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);

  const hidden = await frame(memory.id, anna.user.id);
  await write(app, organizer.token, memory.id, hidden, { body: "Пока видно" });

  const hid = await app.inject(
    as(anna.token, {
      method: "PATCH",
      url: `/memories/${memory.id}/media/${hidden}`,
      payload: { hidden: true },
    }),
  );
  expect(hid.statusCode).toBe(200);

  // Скрытый кадр для всех, кроме хозяина, — «нет такого», и подписи вместе с ним.
  for (const token of [organizer.token, viewer.token]) {
    expect((await info(app, token, memory.id, hidden)).statusCode).toBe(404);
    const answer = await write(app, token, memory.id, hidden, { body: "Пишу в никуда" });
    expect(answer.statusCode).toBe(404);
  }
  // Хозяин свой скрытый кадр видит и комментирует.
  expect(bodies(await commentsOf(app, anna.token, memory.id, hidden))).toEqual(["Пока видно"]);

  await app.close();
});

test("текст: пустой, из одних пробелов, сверх потолка и без поля — 400", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const id = await frame(memory.id, organizer.user.id);

  for (const payload of [
    { body: "" },
    { body: "   " },
    { body: "я".repeat(MAX_COMMENT_LENGTH + 1) },
    {},
    { body: null },
    { body: { text: "не строка" } },
  ]) {
    const answer = await write(app, organizer.token, memory.id, id, payload);
    expect(answer.statusCode, JSON.stringify(payload)).toBe(400);
  }
  expect(await stored(id)).toEqual([]);

  // Ровно потолок — проходит. Потолок считает то, что прислали, а не обрезанное:
  // так же, как у названия лейбла, иначе «длинное с пробелами» проходило бы там,
  // где не проходит короткое.
  const longest = await write(app, organizer.token, memory.id, id, {
    body: "я".repeat(MAX_COMMENT_LENGTH),
  });
  expect(longest.statusCode).toBe(201);
  expect((longest.json() as Comment).body).toBe("я".repeat(MAX_COMMENT_LENGTH));

  // Пробелы по краям срезаются — как у названия воспоминания и лейбла.
  const trimmed = await write(app, organizer.token, memory.id, id, { body: "  Обрезали  " });
  expect(trimmed.statusCode).toBe(201);
  expect((trimmed.json() as Comment).body).toBe("Обрезали");

  await app.close();
});

test("комментарий не выходит за своё воспоминание — отказывает база", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const elsewhere = await createMemory(app, organizer.token);
  const id = await frame(memory.id, organizer.user.id);

  const written = await write(app, organizer.token, memory.id, id, { body: "Своя" });
  expect(written.statusCode).toBe(201);

  // То же самое мимо маршрутов: кадр этого воспоминания под чужим номером
  // воспоминания база не примет — составной внешний ключ, а не обещание.
  await expect(
    sql`
      insert into frame_comments (media_id, memory_id, author_id, body)
      values (${id}, ${elsewhere.id}, ${organizer.user.id}, 'Мимо')
    `,
  ).rejects.toThrow();

  await app.close();
});

test("участник уходит — его кадр уносит подписи, а чужие кадры с его словами стоят", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);

  const hers = await frame(memory.id, anna.user.id);
  const his = await frame(memory.id, organizer.user.id);
  await write(app, anna.token, memory.id, hers, { body: "На моём кадре" });
  // Подпись под чужим кадром — обычное дело, и уход Анны её не уносит: уходит её
  // материал, а не всё, что она сказала.
  await write(app, anna.token, memory.id, his, { body: "На его кадре" });
  expect(await stored(hers)).toHaveLength(1);
  expect(await stored(his)).toHaveLength(1);

  const left = await app.inject(
    as(anna.token, { method: "DELETE", url: `/memories/${memory.id}/members/${anna.user.id}` }),
  );
  expect(left.statusCode).toBe(200);

  expect(await stored(hers)).toEqual([]);
  expect(await stored(his)).toHaveLength(1);
  expect(bodies(await commentsOf(app, organizer.token, memory.id, his))).toEqual(["На его кадре"]);

  await app.close();
});

test("удалили учётную запись — ушли и подписи человека", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);

  const id = await frame(memory.id, anna.user.id);
  const commentId = (await write(app, anna.token, memory.id, id, { body: "Пока был" })).json()
    .id as string;

  await sql`delete from users where id = ${anna.user.id}`;
  // Каскад по author_id — тот же, что у media_items.uploaded_by. Кадр ушёл вместе
  // с человеком раньше, и подпись ушла вместе с ним; здесь проверяем, что убрали
  // строку, которой больше не на что сослаться.
  const rows = await sql<{ id: string }[]>`select id from frame_comments where id = ${commentId}`;
  expect(rows).toEqual([]);

  await app.close();
});
