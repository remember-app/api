import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";

/**
 * Лейблы снаружи, через HTTP: что приходит в списке, что приходит в галерее и —
 * главное — чего там не приходит никогда. Приватность личного лейбла проверяется
 * именно так, глазами второго участника, а не запросом в базу: спрашивающий
 * видит ровно то, что ему отдал маршрут.
 *
 * Лейблы, связи и кадры кладутся прямо SQL-ом: маршрутов записи ещё нет (они в
 * TASK-189), а хранилище для этих проверок не нужно — ссылки галереи
 * подписываются локально, и никто их здесь не открывает.
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
async function frame(memoryId: string, uploadedBy: string, capturedAt: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into media_items (memory_id, uploaded_by, kind, status, original_key, size_bytes,
      captured_at)
    values (${memoryId}, ${uploadedBy}, 'photo', 'ready',
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

/** Положить кадр в лейбл — то, что завтра сделает маршрут из TASK-189. */
const put = (labelId: string, mediaId: string, memoryId: string, addedBy: string) =>
  sql`
    insert into label_media (label_id, media_id, memory_id, added_by)
    values (${labelId}, ${mediaId}, ${memoryId}, ${addedBy})
  `;

const labels = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/labels` }));

const gallery = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/media` }));

const links = async (labelId: string) => {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int from label_media where label_id = ${labelId}
  `;
  return row?.count;
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
  const mine = await labels(app, organizer.token, memory.id);
  expect(mine.statusCode).toBe(200);
  expect(mine.json()).toEqual([
    { id: best, title: "Лучшее", color: 1, shared: true, mine: true, media_count: 2 },
    // Общий лейбл Анны организатор видит, но править его не сможет — `mine` false.
    { id: funny, title: "Смешное", color: 4, shared: true, mine: false, media_count: 0 },
    { id: favourites, title: "Любимые", color: 6, shared: false, mine: true, media_count: 1 },
  ]);

  // Анна: те же два общих и свой личный вместо чужого.
  expect((await labels(app, anna.token, memory.id)).json()).toEqual([
    { id: best, title: "Лучшее", color: 1, shared: true, mine: false, media_count: 2 },
    { id: funny, title: "Смешное", color: 4, shared: true, mine: true, media_count: 0 },
    { id: secret, title: "Секрет", color: 8, shared: false, mine: true, media_count: 2 },
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
    { id: best, title: "Лучшее", color: 1, shared: true, mine: true, media_count: 1 },
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
