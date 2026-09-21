import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";

/**
 * Лейблы снаружи, через HTTP: что приходит в списке, что приходит в галерее,
 * что с ними делают — и, главное, чего там не приходит никогда. Приватность
 * личного лейбла проверяется именно так, глазами второго участника, а не
 * запросом в базу: спрашивающий видит ровно то, что ему отдал маршрут.
 *
 * Три первых теста — про чтение, и лейблы со связями в них кладутся прямо
 * SQL-ом: так фикстура ставит сразу и чужое, и своё, не переключая токены.
 * Дальше идут маршруты записи, и там всё делается ими же — иначе проверялась бы
 * не запись, а фикстура.
 *
 * Хранилище для этих проверок не нужно: ссылки галереи подписываются локально,
 * и никто их здесь не открывает.
 */

const email = () => testEmail("task187");
const titleTag = "task187-test";
const title = () => `${titleTag} ${randomUUID()}`;

afterAll(async () => {
  await sql`delete from memories where title like ${`${titleTag} %`}`;
  await cleanupTestUsers("task187");
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

/**
 * Кадр, уже лежащий в воспоминании: строка со статусом `ready` и ключом, за
 * которым байтов нет. Галерее их и не надо — она подписывает ссылку, не
 * спрашивая хранилище. Счётчики воспоминания фикстура не двигает: их здесь никто
 * не читает, а двигает их маршрут загрузки, который эти проверки обходят.
 */
async function frame(
  memoryId: string,
  uploadedBy: string,
  capturedAt: string,
  status: "ready" | "pending_upload" = "ready",
) {
  const [row] = await sql<{ id: string }[]>`
    insert into media_items (memory_id, uploaded_by, kind, status, original_key, size_bytes,
      captured_at)
    values (${memoryId}, ${uploadedBy}, 'photo', ${status},
      ${`task187/${randomUUID()}`}, 4096, ${capturedAt})
    returning id
  `;
  if (!row) throw new Error("insert into media_items returned no row");
  return row.id;
}

async function label(memoryId: string, ownerId: string, name: string, shared: boolean, color = 1) {
  const [row] = await sql<{ id: string }[]>`
    insert into labels (memory_id, owner_id, title, color, shared)
    values (${memoryId}, ${ownerId}, ${name}, ${color}, ${shared})
    returning id
  `;
  if (!row) throw new Error("insert into labels returned no row");
  return row.id;
}

/** Положить кадр в лейбл в обход маршрута — фикстура тестов на чтение. */
const put = (labelId: string, mediaId: string, memoryId: string, addedBy: string) =>
  sql`
    insert into label_media (label_id, media_id, memory_id, added_by)
    values (${labelId}, ${mediaId}, ${memoryId}, ${addedBy})
  `;

const labels = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/labels` }));

/**
 * Строка списка, какой её отдаёт маршрут, в самом обычном случае: свой лейбл,
 * пустой, всё можно. Тест переписывает поверх ровно то поле, которым его случай
 * от обычного отличается, — так в проверке видно именно его.
 */
const card = (id: string, title: string, color: number, shared: boolean) => ({
  id,
  title,
  color,
  shared,
  mine: true,
  can_edit: true,
  can_add_media: true,
  media_count: 0,
});

const newLabel = (app: App, token: string, memoryId: string, body: Record<string, unknown>) =>
  app.inject(as(token, { method: "POST", url: `/memories/${memoryId}/labels`, payload: body }));

const editLabel = (
  app: App,
  token: string,
  memoryId: string,
  labelId: string,
  body: Record<string, unknown>,
) =>
  app.inject(
    as(token, { method: "PATCH", url: `/memories/${memoryId}/labels/${labelId}`, payload: body }),
  );

const dropLabel = (app: App, token: string, memoryId: string, labelId: string) =>
  app.inject(as(token, { method: "DELETE", url: `/memories/${memoryId}/labels/${labelId}` }));

/** Положить пачку и убрать пачку — те самые два тапа по строке листа. */
const fill = (app: App, token: string, memoryId: string, labelId: string, mediaIds: string[]) =>
  app.inject(
    as(token, {
      method: "POST",
      url: `/memories/${memoryId}/labels/${labelId}/media`,
      payload: { media_ids: mediaIds },
    }),
  );

const take = (app: App, token: string, memoryId: string, labelId: string, mediaIds: string[]) =>
  app.inject(
    as(token, {
      method: "DELETE",
      url: `/memories/${memoryId}/labels/${labelId}/media`,
      payload: { media_ids: mediaIds },
    }),
  );

const gallery = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media` }));

const links = async (labelId: string) => {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int from label_media where label_id = ${labelId}
  `;
  return row?.count;
};

/** Какие лейблы у воспоминания есть на самом деле — включая те, что не видны. */
const stored = async (memoryId: string) => {
  const rows = await sql<{ id: string }[]>`
    select id from labels where memory_id = ${memoryId} order by created_at, id
  `;
  return rows.map((row) => row.id);
};

/** Что в галерее: сами кадры и коробки, в которых они лежат. */
const shelf = async (app: App, token: string, memoryId: string) => {
  const answer = await gallery(app, token, memoryId);
  expect(answer.statusCode).toBe(200);
  return (answer.json() as { id: string; label_ids: string[] }[]).map((item) => [
    item.id,
    item.label_ids,
  ]);
};

test("список лейблов: общие — всем, личные — только хозяину", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());

  const best = await label(memory.id, organizer.user.id, "Лучшее", true, 1);
  const funny = await label(memory.id, anna.user.id, "Смешное", true, 4);
  const favourites = await label(memory.id, organizer.user.id, "Любимые", false, 6);
  const secret = await label(memory.id, anna.user.id, "Секрет", false, 8);

  const hers = await frame(memory.id, anna.user.id, "2026-09-02T19:00:00+03:00");
  const his = await frame(memory.id, organizer.user.id, "2026-09-02T20:00:00+03:00");
  // Чужой кадр в своей коробке — так и задумано: лейбл ничего никому не даёт и
  // не отнимает (doc-13).
  await put(best, hers, memory.id, organizer.user.id);
  await put(best, his, memory.id, anna.user.id);
  await put(favourites, hers, memory.id, organizer.user.id);
  // В личном лейбле Анны два кадра — ни один из них не должен подсчитаться
  // никому другому.
  await put(secret, hers, memory.id, anna.user.id);
  await put(secret, his, memory.id, anna.user.id);

  // Организатор: оба общих и свой личный. Сперва общие, внутри — по названию.
  // Рядом с каждым — что ему с этим лейблом можно: общий лейбл Анны он не
  // заводил (`mine` false), но правит его как организатор.
  const mine = await labels(app, organizer.token, memory.id);
  expect(mine.statusCode).toBe(200);
  expect(mine.json()).toEqual([
    { ...card(best, "Лучшее", 1, true), mine: true, media_count: 2 },
    { ...card(funny, "Смешное", 4, true), mine: false, media_count: 0 },
    { ...card(favourites, "Любимые", 6, false), mine: true, media_count: 1 },
  ]);

  // Анна: те же два общих и свой личный вместо чужого. Чужой общий лейбл она
  // наполняет, но не правит — она не хозяйка и не организатор.
  expect((await labels(app, anna.token, memory.id)).json()).toEqual([
    { ...card(best, "Лучшее", 1, true), mine: false, can_edit: false, media_count: 2 },
    { ...card(funny, "Смешное", 4, true), mine: true, media_count: 0 },
    { ...card(secret, "Секрет", 8, false), mine: true, media_count: 2 },
  ]);

  // Зритель: общие есть, своих нет — и это пустота, а не отказ.
  const seen = await labels(app, viewer.token, memory.id);
  expect(seen.json().map((item: { id: string }) => item.id)).toEqual([best, funny]);

  // Чужих личных нет ни у кого: ни строкой, ни названием, ни id — проверяется по
  // телу ответа целиком, потому что «не приходит» значит именно это.
  for (const token of [organizer.token, viewer.token]) {
    const body = (await labels(app, token, memory.id)).body;
    expect(body).not.toContain(secret);
    expect(body).not.toContain("Секрет");
  }
  expect((await labels(app, anna.token, memory.id)).body).not.toContain("Любимые");

  // Не участник, несуществующее воспоминание и кривой id — общий 404, байт в байт.
  for (const id of [memory.id, randomUUID(), "not-a-uuid"]) {
    const answer = await labels(app, stranger.token, id);
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  expect(
    (await app.inject({ method: "GET", url: `/memories/${memory.id}/labels` })).statusCode,
  ).toBe(401);

  await app.close();
});

test("галерея: у кадра свои лейблы, чужой личный не просвечивает", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);

  const early = await frame(memory.id, anna.user.id, "2026-09-02T19:00:00+03:00");
  const late = await frame(memory.id, organizer.user.id, "2026-09-02T20:00:00+03:00");
  const bare = await frame(memory.id, anna.user.id, "2026-09-02T21:00:00+03:00");

  const best = await label(memory.id, organizer.user.id, "Лучшее", true, 1);
  const funny = await label(memory.id, anna.user.id, "Смешное", true, 4);
  const favourites = await label(memory.id, organizer.user.id, "Любимые", false, 6);
  // Один кадр в трёх лейблах сразу.
  await put(best, early, memory.id, organizer.user.id);
  await put(funny, early, memory.id, anna.user.id);
  await put(favourites, early, memory.id, organizer.user.id);
  await put(best, late, memory.id, organizer.user.id);

  const owners = await gallery(app, organizer.token, memory.id);
  expect(owners.statusCode).toBe(200);
  // Состав и порядок — прежние: три кадра по времени съёмки, и тот, что лежит в
  // трёх лейблах, пришёл один раз.
  expect(owners.json().map((item: { id: string }) => item.id)).toEqual([early, late, bare]);
  const [first, second, third] = owners.json();
  // Порядок лейблов — тот же, что в списке: сперва общие, внутри по названию.
  expect(first.label_ids).toEqual([best, funny, favourites]);
  expect(second.label_ids).toEqual([best]);
  // Кадр, не лежащий нигде, — пустой массив, а не null.
  expect(third.label_ids).toEqual([]);

  // Анна на тот же кадр: только общие. Личного лейбла организатора нет ни в
  // массиве, ни где-либо ещё в ответе.
  const hers = await gallery(app, anna.token, memory.id);
  expect(hers.json().map((item: { id: string }) => item.id)).toEqual([early, late, bare]);
  expect(hers.json()[0].label_ids).toEqual([best, funny]);
  expect(hers.body).not.toContain(favourites);

  await app.close();
});

test("ушедший кадр уходит из лейблов, лейбл остаётся, связь переживает ушедшего", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const elsewhere = await createMemory(app, organizer.token);

  const doomed = await frame(memory.id, organizer.user.id, "2026-09-02T19:00:00+03:00");
  const hers = await frame(memory.id, anna.user.id, "2026-09-02T20:00:00+03:00");
  const survivor = await frame(memory.id, organizer.user.id, "2026-09-02T21:00:00+03:00");
  const best = await label(memory.id, organizer.user.id, "Лучшее", true, 1);
  // Все три кадра разложила Анна, и два из них — чужие: лейбл не про владение.
  await put(best, doomed, memory.id, anna.user.id);
  await put(best, hers, memory.id, anna.user.id);
  await put(best, survivor, memory.id, anna.user.id);
  expect(await links(best)).toBe(3);

  // Кадр удалили поштучно — он пропал из лейбла, лейбл остался.
  const deleted = await app.inject(
    as(organizer.token, { method: "DELETE", url: `/memories/${memory.id}/media/${doomed}` }),
  );
  expect(deleted.statusCode).toBe(200);
  expect(await links(best)).toBe(2);

  // Анна уходит: её кадр уходит с ней и из лейбла тоже. А чужие кадры, которые
  // разложила она, остаются лежать — вместе с её подписью под связью.
  const left = await app.inject(
    as(anna.token, { method: "DELETE", url: `/memories/${memory.id}/members/${anna.user.id}` }),
  );
  expect(left.statusCode).toBe(200);
  expect((await labels(app, organizer.token, memory.id)).json()).toEqual([
    { ...card(best, "Лучшее", 1, true), media_count: 1 },
  ]);
  const [link] = await sql<{ media_id: string; added_by: string | null }[]>`
    select media_id, added_by from label_media where label_id = ${best}
  `;
  expect(link).toEqual({ media_id: survivor, added_by: anna.user.id });

  // Не стало и самой учётной записи — связь всё равно остаётся, забывается
  // только подпись: кадр не выпадает из чужой коробки оттого, что разложивший
  // его человек стёр себя.
  await sql`delete from users where id = ${anna.user.id}`;
  const [forgotten] = await sql<{ added_by: string | null }[]>`
    select added_by from label_media where label_id = ${best} and media_id = ${survivor}
  `;
  expect(forgotten).toEqual({ added_by: null });

  // Лейбл не выходит за своё воспоминание: кадр соседнего в него не положить, и
  // отказывает в этом база, а не маршрут — ни под своим номером воспоминания,
  // ни под чужим.
  const stray = await frame(elsewhere.id, organizer.user.id, "2026-09-02T19:00:00+03:00");
  await expect(put(best, stray, memory.id, organizer.user.id)).rejects.toThrow();
  await expect(put(best, stray, elsewhere.id, organizer.user.id)).rejects.toThrow();

  // И дважды в один лейбл один кадр не ложится.
  await expect(put(best, survivor, memory.id, organizer.user.id)).rejects.toThrow();

  await app.close();
});

test("завести лейбл: сразу с кадрами — или не завести вовсе", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const elsewhere = await createMemory(app, organizer.token);

  const early = await frame(memory.id, organizer.user.id, "2026-09-02T19:00:00+03:00");
  const late = await frame(memory.id, organizer.user.id, "2026-09-02T20:00:00+03:00");
  const stray = await frame(elsewhere.id, organizer.user.id, "2026-09-02T19:00:00+03:00");

  // Пробелы по краям названия обрезаются, как у названия воспоминания.
  const created = await newLabel(app, organizer.token, memory.id, {
    title: "  Лучшее  ",
    color: 1,
    shared: true,
    media_ids: [early, late],
  });
  expect(created.statusCode).toBe(201);
  const best = created.json().id;
  expect(created.json()).toEqual({ ...card(best, "Лучшее", 1, true), media_count: 2 });

  // Кадры действительно в коробке, и это видно снаружи — из галереи.
  expect(await shelf(app, organizer.token, memory.id)).toEqual([
    [early, [best]],
    [late, [best]],
  ]);

  // Пустой лейбл — обычное дело: его заводят и не из режима выбора.
  const empty = await newLabel(app, organizer.token, memory.id, {
    title: "На печать",
    color: 5,
    shared: false,
  });
  expect(empty.statusCode).toBe(201);
  expect(empty.json()).toEqual(card(empty.json().id, "На печать", 5, false));

  // Пустое название и сверх предела, цвет мимо палитры и дробный, несказанные
  // цвет и вид, лишнее поле, пустая пачка — понятный отказ на каждое.
  for (const body of [
    { title: "   ", color: 1, shared: true },
    { title: "я".repeat(101), color: 1, shared: true },
    { title: "Цвет", color: 9, shared: true },
    { title: "Цвет", color: 0, shared: true },
    { title: "Цвет", color: 1.5, shared: true },
    { title: "Без цвета", shared: true },
    { title: "Без вида", color: 1 },
    { title: "Пустая пачка", color: 1, shared: true, media_ids: [] },
  ]) {
    expect((await newLabel(app, organizer.token, memory.id, body)).statusCode).toBe(400);
  }

  // Кадр соседнего воспоминания и кадр, которого нет вовсе, — отказ всей пачке,
  // с именами; и лейбл при этом не заводится: вместе или никак.
  const ghost = randomUUID();
  const refused = await newLabel(app, organizer.token, memory.id, {
    title: "Не выйдет",
    color: 2,
    shared: false,
    media_ids: [early, stray, ghost],
  });
  expect(refused.statusCode).toBe(400);
  expect(refused.json()).toEqual({
    error: "no such media in this memory",
    media_ids: [stray, ghost],
  });
  expect((await stored(memory.id)).sort()).toEqual([best, empty.json().id].sort());

  await app.close();
});

test("пачка: положить, повторить, убрать — кадры при этом никуда не деваются", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const elsewhere = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);

  const early = await frame(memory.id, anna.user.id, "2026-09-02T19:00:00+03:00");
  const middle = await frame(memory.id, organizer.user.id, "2026-09-02T20:00:00+03:00");
  const late = await frame(memory.id, anna.user.id, "2026-09-02T21:00:00+03:00");
  const stray = await frame(elsewhere.id, organizer.user.id, "2026-09-02T19:00:00+03:00");
  // Кадр, который ещё летит: в галерее его нет, и для лейбла его тоже нет.
  const flying = await frame(
    memory.id,
    anna.user.id,
    "2026-09-02T22:00:00+03:00",
    "pending_upload",
  );

  const best = (
    await newLabel(app, organizer.token, memory.id, { title: "Лучшее", color: 1, shared: true })
  ).json().id;

  // Кладёт Анна — чужую коробку она наполняет, но не правит. И чужой кадр в
  // пачке её не смущает: лейбл прав не даёт и не отнимает.
  const put = await fill(app, anna.token, memory.id, best, [early, middle]);
  expect(put.statusCode).toBe(200);
  expect(put.json()).toEqual({
    ...card(best, "Лучшее", 1, true),
    mine: false,
    can_edit: false,
    media_count: 2,
  });

  // Уже лежащий кадр в пачке — не ошибка и не дубль.
  expect((await fill(app, anna.token, memory.id, best, [middle, late])).json().media_count).toBe(3);
  expect(await links(best)).toBe(3);

  // Кадр соседнего воспоминания, несуществующий и ещё не долетевший — отказ
  // всей пачке: ничего не легло даже наполовину.
  for (const bad of [stray, randomUUID(), flying]) {
    const bounced = await fill(app, anna.token, memory.id, best, [early, bad]);
    expect(bounced.statusCode).toBe(400);
    expect(bounced.json()).toEqual({ error: "no such media in this memory", media_ids: [bad] });
  }
  expect(await links(best)).toBe(3);

  // Тот же кадр во второй коробке — в галерее он всё равно один.
  const funny = (
    await newLabel(app, anna.token, memory.id, {
      title: "Смешное",
      color: 4,
      shared: true,
      media_ids: [late],
    })
  ).json().id;
  expect(await shelf(app, anna.token, memory.id)).toEqual([
    [early, [best]],
    [middle, [best]],
    [late, [best, funny]],
  ]);

  // Убрать пачкой — из коробки, а не из воспоминания.
  const taken = await take(app, anna.token, memory.id, best, [early, middle]);
  expect(taken.statusCode).toBe(200);
  expect(taken.json().media_count).toBe(1);
  // Убрать то, чего в коробке нет, — не ошибка, как и положить уже лежащее.
  expect((await take(app, anna.token, memory.id, best, [early])).json().media_count).toBe(1);
  // Кадры на местах и в прежнем порядке — ушли только связи.
  expect(await shelf(app, anna.token, memory.id)).toEqual([
    [early, []],
    [middle, []],
    [late, [best, funny]],
  ]);

  // Пустая пачка, несказанная и с повтором — не действие.
  for (const payload of [{ media_ids: [] }, {}, { media_ids: [early, early] }]) {
    const answer = await app.inject(
      as(anna.token, {
        method: "POST",
        url: `/memories/${memory.id}/labels/${best}/media`,
        payload,
      }),
    );
    expect(answer.statusCode).toBe(400);
  }

  await app.close();
});

test("переименовать, перекрасить, удалить — и кадры этого не замечают", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const elsewhere = await createMemory(app, organizer.token);
  const early = await frame(memory.id, organizer.user.id, "2026-09-02T19:00:00+03:00");
  const late = await frame(memory.id, organizer.user.id, "2026-09-02T20:00:00+03:00");

  const best = (
    await newLabel(app, organizer.token, memory.id, {
      title: "Лучшее",
      color: 1,
      shared: true,
      media_ids: [early, late],
    })
  ).json().id;

  const renamed = await editLabel(app, organizer.token, memory.id, best, { title: "  Смешное  " });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json()).toEqual({ ...card(best, "Смешное", 1, true), media_count: 2 });
  expect((await editLabel(app, organizer.token, memory.id, best, { color: 7 })).json()).toEqual({
    ...card(best, "Смешное", 7, true),
    media_count: 2,
  });

  // Пустая правка — не правка, мимо палитры не перекрасить и в пустое имя не
  // переименовать.
  for (const body of [{}, { color: 9 }, { title: "  " }]) {
    expect((await editLabel(app, organizer.token, memory.id, best, body)).statusCode).toBe(400);
  }

  // Общий ↔ личный после создания не переключается: такого поля у маршрута нет,
  // и присланное отбрасывается, не доезжая до запроса, — лейбл остаётся общим.
  const ignored = await editLabel(app, organizer.token, memory.id, best, {
    title: "Смешное",
    shared: false,
  });
  expect(ignored.statusCode).toBe(200);
  expect(ignored.json().shared).toBe(true);

  // Лейбл соседнего воспоминания, несуществующий и кривой id — общий 404 на
  // любую запись, байт в байт.
  const alien = (
    await newLabel(app, organizer.token, elsewhere.id, { title: "Чужой", color: 1, shared: true })
  ).json().id;
  for (const id of [alien, randomUUID(), "not-a-uuid"]) {
    for (const answer of [
      await editLabel(app, organizer.token, memory.id, id, { title: "Никак" }),
      await dropLabel(app, organizer.token, memory.id, id),
      await fill(app, organizer.token, memory.id, id, [early]),
      await take(app, organizer.token, memory.id, id, [early]),
    ]) {
      expect(answer.statusCode).toBe(404);
      expect(answer.body).toBe('{"error":"not found"}');
    }
  }

  const dropped = await dropLabel(app, organizer.token, memory.id, best);
  expect(dropped.statusCode).toBe(200);
  expect(dropped.json()).toEqual({ ok: true });
  expect(await stored(memory.id)).toEqual([]);
  // Кадры остались там же, где лежали, и галерея их не потеряла.
  expect(await shelf(app, organizer.token, memory.id)).toEqual([
    [early, []],
    [late, []],
  ]);
  // Второй раз — «нет такого».
  expect((await dropLabel(app, organizer.token, memory.id, best)).statusCode).toBe(404);

  await app.close();
});

test("права на общем лейбле: кто правит, кто кладёт, кто убирает (ВРЕМЕННО, decision-12)", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const boris = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);

  const hers = await frame(memory.id, anna.user.id, "2026-09-02T19:00:00+03:00");
  const his = await frame(memory.id, boris.user.id, "2026-09-02T20:00:00+03:00");

  const created = await newLabel(app, anna.token, memory.id, {
    title: "Смешное",
    color: 4,
    shared: true,
    media_ids: [hers],
  });
  expect(created.statusCode).toBe(201);
  const funny = created.json().id;

  // Что кому можно, сказано прямо в списке — тем же правилом, что отказывает
  // маршрутам, чтобы экран не считал это сам.
  const seen = async (token: string) => (await labels(app, token, memory.id)).json()[0];
  expect(await seen(organizer.token)).toEqual({
    ...card(funny, "Смешное", 4, true),
    mine: false,
    media_count: 1,
  });
  expect(await seen(boris.token)).toEqual({
    ...card(funny, "Смешное", 4, true),
    mine: false,
    can_edit: false,
    media_count: 1,
  });
  expect(await seen(viewer.token)).toEqual({
    ...card(funny, "Смешное", 4, true),
    mine: false,
    can_edit: false,
    can_add_media: false,
    media_count: 1,
  });

  // Сосед-contributor чужой общий лейбл наполняет, но не правит и не удаляет.
  expect((await editLabel(app, boris.token, memory.id, funny, { title: "Моё" })).statusCode).toBe(
    403,
  );
  const refused = await dropLabel(app, boris.token, memory.id, funny);
  expect(refused.statusCode).toBe(403);
  expect(refused.body).toBe('{"error":"forbidden"}');
  expect((await fill(app, boris.token, memory.id, funny, [his])).statusCode).toBe(200);

  // Организатор правит и чужой общий: он в воспоминании за всё.
  expect(
    (await editLabel(app, organizer.token, memory.id, funny, { title: "Общее" })).statusCode,
  ).toBe(200);

  // Убирает тот, кто положил. Чужой кадр Борису не убрать, и пачка с ним
  // отказывается целиком — половины не бывает.
  expect((await take(app, boris.token, memory.id, funny, [hers])).statusCode).toBe(403);
  expect((await take(app, boris.token, memory.id, funny, [his, hers])).statusCode).toBe(403);
  expect(await links(funny)).toBe(2);
  expect((await take(app, boris.token, memory.id, funny, [his])).statusCode).toBe(200);
  expect(await links(funny)).toBe(1);

  // А хозяйка лейбла и организатор убирают что угодно, кто бы ни положил.
  await fill(app, boris.token, memory.id, funny, [his]);
  expect((await take(app, anna.token, memory.id, funny, [his])).statusCode).toBe(200);
  await fill(app, boris.token, memory.id, funny, [his]);
  expect((await take(app, organizer.token, memory.id, funny, [his])).statusCode).toBe(200);

  // Зритель на общем лейбле не пишет ничего — тем же «нельзя», каким ему
  // отказывают остальные маршруты.
  expect(
    (await newLabel(app, viewer.token, memory.id, { title: "Общий", color: 1, shared: true }))
      .statusCode,
  ).toBe(403);
  for (const answer of [
    await fill(app, viewer.token, memory.id, funny, [hers]),
    await take(app, viewer.token, memory.id, funny, [hers]),
    await editLabel(app, viewer.token, memory.id, funny, { title: "Никак" }),
    await dropLabel(app, viewer.token, memory.id, funny),
  ]) {
    expect(answer.statusCode).toBe(403);
    expect(answer.body).toBe('{"error":"forbidden"}');
  }

  // Свой личный он заводит и наполняет — это у зрителя есть.
  const own = await newLabel(app, viewer.token, memory.id, {
    title: "Моё",
    color: 2,
    shared: false,
    media_ids: [hers],
  });
  expect(own.statusCode).toBe(201);
  expect(own.json()).toEqual({ ...card(own.json().id, "Моё", 2, false), media_count: 1 });
  expect((await take(app, viewer.token, memory.id, own.json().id, [hers])).statusCode).toBe(200);

  await app.close();
});

test("чужой личный лейбл на любую запись: «не найдено», как будто его нет", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const hers = await frame(memory.id, anna.user.id, "2026-09-02T19:00:00+03:00");

  const secret = (
    await newLabel(app, anna.token, memory.id, {
      title: "Секрет",
      color: 8,
      shared: false,
      media_ids: [hers],
    })
  ).json().id;

  // Даже организатор его «не находит»: ни положить, ни убрать, ни
  // переименовать, ни удалить — и ответ тот же, что у несуществующего.
  for (const answer of [
    await fill(app, organizer.token, memory.id, secret, [hers]),
    await take(app, organizer.token, memory.id, secret, [hers]),
    await editLabel(app, organizer.token, memory.id, secret, { title: "Моё" }),
    await dropLabel(app, organizer.token, memory.id, secret),
  ]) {
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toBe('{"error":"not found"}');
  }
  expect(await links(secret)).toBe(1);
  expect(await stored(memory.id)).toEqual([secret]);

  // Хозяйке — всё то же самое можно.
  expect((await editLabel(app, anna.token, memory.id, secret, { title: "Моё" })).statusCode).toBe(
    200,
  );
  expect((await dropLabel(app, anna.token, memory.id, secret)).statusCode).toBe(200);

  await app.close();
});

test("ушёл участник: личные лейблы уходят с ним, общие достаются организатору", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const anna = await member(app, memory.id, "contributor", organizer.user.id);
  const hers = await frame(memory.id, anna.user.id, "2026-09-02T19:00:00+03:00");
  const his = await frame(memory.id, organizer.user.id, "2026-09-02T20:00:00+03:00");

  const shared = (
    await newLabel(app, anna.token, memory.id, {
      title: "Смешное",
      color: 4,
      shared: true,
      media_ids: [hers, his],
    })
  ).json().id;
  const personal = (
    await newLabel(app, anna.token, memory.id, {
      title: "Секрет",
      color: 8,
      shared: false,
      media_ids: [hers, his],
    })
  ).json().id;

  const left = await app.inject(
    as(anna.token, { method: "DELETE", url: `/memories/${memory.id}/members/${anna.user.id}` }),
  );
  expect(left.statusCode).toBe(200);

  // Личный ушёл вместе с ней — из базы, а не только из чьего-то списка.
  expect(await stored(memory.id)).toEqual([shared]);
  expect(await links(personal)).toBe(0);
  // Общий остался стоять, и хозяин ему теперь организатор: он его и правит.
  expect((await labels(app, organizer.token, memory.id)).json()).toEqual([
    { ...card(shared, "Смешное", 4, true), media_count: 1 },
  ]);
  expect((await editLabel(app, organizer.token, memory.id, shared, { color: 3 })).statusCode).toBe(
    200,
  );
  // Её кадр ушёл с ней и из коробки; его кадр остался и там, и в галерее.
  expect(await shelf(app, organizer.token, memory.id)).toEqual([[his, [shared]]]);

  await app.close();
});
