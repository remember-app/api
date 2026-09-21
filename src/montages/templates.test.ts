import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";
import type { MemberRole } from "../memories/plugin.ts";

/**
 * Шесть готовых роликов, против той же настоящей базы, что и остальные тесты
 * здесь. Хранилище не нужно: маршрут ничего не подписывает — он отдаёт то же
 * самое тело заказа, только заполненное заранее.
 */

const email = () => testEmail("task198");
const titleTag = "task198-test";
const title = () => `${titleTag} ${randomUUID()}`;
const mine = `${titleTag} %`;

// Порядок тот же, что в montages.test.ts: сначала задачи в чужой таблице
// `jobs`, потом воспоминания, и только потом люди — `montages.ordered_by`
// нарочно без ON DELETE.
afterAll(async () => {
  await sql`
    delete from jobs where type = 'montage' and ref in (
      select id::text from montages where memory_id in (
        select id from memories where title like ${mine}
      )
    )
  `;
  await sql`delete from memories where title like ${mine}`;
  await cleanupTestUsers("task198");
  await sql.end();
});

type App = ReturnType<typeof buildTestApp>["app"];

type Template = {
  id: string;
  story_text: string;
  target_seconds: number;
  orientation: string;
  music_tracks: string[];
  music_note: string | null;
};

const as = (token: string, options: InjectOptions) => ({
  ...options,
  headers: { authorization: `Bearer ${token}` },
});

const createMemory = async (app: App, token: string, named = title()) => {
  const created = await app.inject(
    as(token, {
      method: "POST",
      url: "/memories",
      // Один вечер по московскому времени: в UTC это тот же день, и рассказ
      // называет «2 сентября 2026 г.».
      payload: { title: named, event_start: "2026-09-02T18:00:00+03:00" },
    }),
  );
  expect(created.statusCode).toBe(201);
  return created.json() as { id: string; title: string };
};

async function member(app: App, memoryId: string, role: MemberRole, by: string) {
  const person = await signIn(app, email());
  await sql`
    insert into memory_members (memory_id, user_id, role, invited_by)
    values (${memoryId}, ${person.user.id}, ${role}, ${by})
  `;
  return person;
}

/** Материал там, где его оставила бы загрузка; секунды — предел длины ролика. */
async function material(memoryId: string, uploadedBy: string, seconds: number[]) {
  for (const duration of seconds) {
    await sql`
      insert into media_items (
        memory_id, uploaded_by, kind, status, original_key, size_bytes, duration_seconds
      )
      values (
        ${memoryId}, ${uploadedBy}, 'video', 'ready', ${`originals/${randomUUID()}`}, 4096,
        ${duration}
      )
    `;
  }
}

const ask = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "GET", url: `/memories/${memoryId}/montage-templates` }));

const speak = (app: App, token: string, language: "ru" | "en") =>
  app.inject(as(token, { method: "POST", url: "/me/language", payload: { language } }));

test("шесть шаблонов в порядке макета, каждый со своей длиной, форматом и музыкой", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  // Материала с запасом: длины шаблонов не должны быть ничем зажаты.
  await material(memory.id, organizer.user.id, [600, 600]);

  const reply = await ask(app, organizer.token, memory.id);
  expect(reply.statusCode).toBe(200);
  const templates = reply.json() as Template[];

  expect(
    templates.map(({ id, target_seconds, orientation, music_tracks }) => ({
      id,
      target_seconds,
      orientation,
      music_tracks,
    })),
  ).toEqual([
    { id: "for_myself", target_seconds: 180, orientation: "landscape", music_tracks: ["calm"] },
    { id: "quick", target_seconds: 60, orientation: "landscape", music_tracks: ["bright"] },
    { id: "report", target_seconds: 120, orientation: "landscape", music_tracks: ["calm"] },
    { id: "short_form", target_seconds: 30, orientation: "portrait", music_tracks: ["bright"] },
    { id: "parents", target_seconds: 150, orientation: "landscape", music_tracks: ["warm"] },
    {
      id: "dopamine",
      target_seconds: 45,
      orientation: "portrait",
      music_tracks: ["bright", "road"],
    },
  ]);

  // Пожелание к трекам — только там, где оно что-то говорит; у остальных поле
  // есть и пустое, чтобы приложению не гадать, отдали его или забыли.
  for (const template of templates) {
    expect(template.story_text.length).toBeGreaterThan(0);
    expect(template.music_note === null || template.music_note.length > 0).toBe(true);
  }
  expect(templates.find((one) => one.id === "dopamine")?.music_note).toMatch(/трека/);
  expect(templates.find((one) => one.id === "quick")?.music_note).toBeNull();
});

test("длина шаблона не выходит за предел воспоминания", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  // Ровно сорок секунд материала — предел этого воспоминания.
  await material(memory.id, organizer.user.id, [20, 10, 10]);

  const templates = (await ask(app, organizer.token, memory.id)).json() as Template[];
  // Шаблон на три минуты отдаёт сорок, а тот, что короче предела, — себя.
  expect(templates.find((one) => one.id === "for_myself")?.target_seconds).toBe(40);
  expect(templates.find((one) => one.id === "parents")?.target_seconds).toBe(40);
  expect(templates.find((one) => one.id === "short_form")?.target_seconds).toBe(30);
});

test("история собрана из названия, дат и числа участников, на языке организатора", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const named = title();
  const memory = await createMemory(app, organizer.token, named);
  await material(memory.id, organizer.user.id, [600]);
  // Двое принесут кадры, зритель — нет, и в рассказе его быть не должно.
  await member(app, memory.id, "contributor", organizer.user.id);
  await member(app, memory.id, "viewer", organizer.user.id);

  const russian = (await ask(app, organizer.token, memory.id)).json() as Template[];
  for (const template of russian) {
    expect(template.story_text).toContain(named);
    expect(template.story_text).toContain("2 сентября 2026");
    expect(template.story_text).toContain("от 2 человек");
    expect(template.story_text.length).toBeLessThanOrEqual(600);
  }

  expect((await speak(app, organizer.token, "en")).statusCode).toBe(200);
  const english = (await ask(app, organizer.token, memory.id)).json() as Template[];
  for (const [index, template] of english.entries()) {
    expect(template.story_text).toContain(named);
    expect(template.story_text).toContain("2 September 2026");
    expect(template.story_text).toContain("from 2 people");
    expect(template.story_text.length).toBeLessThanOrEqual(600);
    // Написано руками с нуля, а не тем же текстом на другой раскладке.
    expect(template.story_text).not.toBe(russian[index]?.story_text);
  }
  expect(english.find((one) => one.id === "parents")?.music_note).toMatch(/beat/);
});

test("период показан одним куском, а один человек — в единственном числе", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const created = await app.inject(
    as(organizer.token, {
      method: "POST",
      url: "/memories",
      payload: {
        title: title(),
        event_start: "2026-09-02T12:00:00+03:00",
        event_end: "2026-09-05T12:00:00+03:00",
      },
    }),
  );
  expect(created.statusCode).toBe(201);
  const memory = created.json() as { id: string };
  await material(memory.id, organizer.user.id, [600]);

  const [first] = (await ask(app, organizer.token, memory.id)).json() as Template[];
  expect(first?.story_text).toContain("2–5 сентября 2026");
  expect(first?.story_text).toContain("от 1 человека");

  expect((await speak(app, organizer.token, "en")).statusCode).toBe(200);
  const [english] = (await ask(app, organizer.token, memory.id)).json() as Template[];
  // Тире между числами английская локаль обставляет своими пробелами — важно
  // тут, что период один кусок, а не два числа порознь.
  expect(english?.story_text).toMatch(/2\s*–\s*5 September 2026/);
  expect(english?.story_text).toContain("from 1 person");
});

test("с самым длинным названием рассказ всё ещё влезает в поле", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  // Двести символов — потолок названия; заготовки написаны так, чтобы с таким
  // названием уложиться в 600. Этот тест их короткими и держит: в коде обрезки
  // нет, и новая заготовка длиннее прежних споткнётся здесь.
  const long = `${titleTag} ${"о".repeat(200 - titleTag.length - 1)}`;
  const memory = await createMemory(app, organizer.token, long);
  await material(memory.id, organizer.user.id, [600]);

  for (const language of ["ru", "en"] as const) {
    expect((await speak(app, organizer.token, language)).statusCode).toBe(200);
    for (const template of (await ask(app, organizer.token, memory.id)).json() as Template[]) {
      expect(template.story_text.length, `${language} ${template.id}`).toBeLessThanOrEqual(600);
      // Название подставлено как есть, без сокращений и пересказа.
      expect(template.story_text).toContain(long);
    }
  }
});

test("шаблоны — организатору: участнику 403, зрителю 403, чужому 404", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, [600]);

  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());

  expect((await ask(app, contributor.token, memory.id)).statusCode).toBe(403);
  expect((await ask(app, viewer.token, memory.id)).statusCode).toBe(403);
  const outside = await ask(app, stranger.token, memory.id);
  expect(outside.statusCode).toBe(404);
  expect(outside.json()).toEqual({ error: "not found" });
  // Несуществующее воспоминание и мусор вместо id — тот же один 404.
  expect((await ask(app, organizer.token, randomUUID())).statusCode).toBe(404);
  expect((await ask(app, organizer.token, "not-a-uuid")).statusCode).toBe(404);
  // И без сессии сюда не попасть.
  const anonymous = await app.inject({
    method: "GET",
    url: `/memories/${memory.id}/montage-templates`,
  });
  expect(anonymous.statusCode).toBe(401);
});

test("каждый шаблон принимается заказом как есть", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, [600, 600, 600]);

  const templates = (await ask(app, organizer.token, memory.id)).json() as Template[];
  expect(templates).toHaveLength(6);

  for (const { id, music_note, ...body } of templates) {
    // Тело заказа — это шаблон без `id`: id называет карточку, а не пожелание.
    const ordered = await app.inject(
      as(organizer.token, {
        method: "POST",
        url: `/memories/${memory.id}/montages`,
        payload: { ...body, ...(music_note === null ? {} : { music_note }) },
      }),
    );
    expect(ordered.statusCode, `${id}: ${ordered.body}`).toBe(201);
    expect(ordered.json().params).toMatchObject({
      target_seconds: body.target_seconds,
      story_text: body.story_text,
      orientation: body.orientation,
      music_tracks: body.music_tracks,
    });
  }
});
