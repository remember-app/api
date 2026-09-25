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
  music_wishes: Record<string, string>;
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

/**
 * Материал там, где его оставила бы загрузка: секунды — видео такой длины
 * (`null` — видео без измеренной длины), "photo" — фото. Предел длины ролика
 * считается по ним.
 */
async function material(
  memoryId: string,
  uploadedBy: string,
  items: (number | null | "photo")[],
  status: "ready" | "processing" = "ready",
) {
  for (const item of items) {
    await sql`
      insert into media_items (
        memory_id, uploaded_by, kind, status, original_key, size_bytes, duration_seconds
      )
      values (
        ${memoryId}, ${uploadedBy}, ${item === "photo" ? "photo" : "video"}, ${status},
        ${`originals/${randomUUID()}`}, 4096, ${item === "photo" ? null : item}
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
  await material(memory.id, organizer.user.id, [600, 600, 600]);

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

  // Пожелание — у того трека шаблона, о котором оно, и только там, где оно
  // что-то говорит; у остальных поле есть и пустое, чтобы приложению не
  // гадать, отдали его или забыли.
  for (const template of templates) {
    expect(template.story_text.length).toBeGreaterThan(0);
    for (const [track, wish] of Object.entries(template.music_wishes)) {
      expect(template.music_tracks, template.id).toContain(track);
      expect(wish.length, `${template.id} ${track}`).toBeGreaterThan(0);
    }
  }
  const wishes = Object.fromEntries(templates.map((one) => [one.id, one.music_wishes]));
  expect(wishes.quick).toEqual({});
  expect(Object.keys(wishes.parents ?? {})).toEqual(["warm"]);
  expect(wishes.parents?.warm).toMatch(/в такт/);
  expect(wishes.dopamine?.bright).toMatch(/разгоняет/);
  expect(wishes.dopamine?.road).toMatch(/гуща/);
});

test("длина шаблона не выходит за предел воспоминания", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  // Сорок одна секунда видео без двух склеек по полсекунды — ровно сорок,
  // предел этого воспоминания.
  await material(memory.id, organizer.user.id, [21, 10, 10]);

  const templates = (await ask(app, organizer.token, memory.id)).json() as Template[];
  // Шаблон на три минуты отдаёт сорок, а тот, что короче предела, — себя.
  expect(templates.find((one) => one.id === "for_myself")?.target_seconds).toBe(40);
  expect(templates.find((one) => one.id === "parents")?.target_seconds).toBe(40);
  expect(templates.find((one) => one.id === "short_form")?.target_seconds).toBe(30);
});

const preview = (app: App, token: string, memoryId: string, payload: object = {}) =>
  app.inject(as(token, { method: "POST", url: `/memories/${memoryId}/montages/preview`, payload }));

test("отсеянное в предел шаблонов не идёт — предел тот же, что на итоге", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  // Сорок секунд у организатора и полминуты от участника, которую отсев счёл
  // смазанной: воркер её не возьмёт, и шаблон на три минуты отдаёт сорок, а
  // рассказ — «от 1 человека», как и итог.
  await material(memory.id, organizer.user.id, [21, 10, 10]);
  const brought = await member(app, memory.id, "contributor", organizer.user.id);
  await material(memory.id, brought.user.id, [30]);
  await sql`
    update media_items set screening_rejected = true, screening_reason = 'blur'
    where memory_id = ${memory.id} and uploaded_by = ${brought.user.id}
  `;

  const templates = (await ask(app, organizer.token, memory.id)).json() as Template[];
  const summary = (await preview(app, organizer.token, memory.id)).json();
  expect(summary).toMatchObject({ max_seconds: 40, people: 1 });
  expect(templates.find((one) => one.id === "for_myself")?.target_seconds).toBe(40);
  for (const template of templates) expect(template.story_text).toContain("от 1 человека");
});

test("история — из названия, дат и числа тех, чьи кадры в материале, того же, что на итоге", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const named = title();
  const memory = await createMemory(app, organizer.token, named);
  await material(memory.id, organizer.user.id, [200, 200, 200]);
  // Кадры принёс один участник из двух. Второй и зритель не принесли ничего,
  // и ни в рассказе, ни на итоге их нет.
  const brought = await member(app, memory.id, "contributor", organizer.user.id);
  await material(memory.id, brought.user.id, [100]);
  await member(app, memory.id, "contributor", organizer.user.id);
  await member(app, memory.id, "viewer", organizer.user.id);
  // Принёс кадры, но ни один ещё не готов: в ролик он не попадёт, а значит, и в
  // счёт людей тоже.
  const pending = await member(app, memory.id, "contributor", organizer.user.id);
  await material(memory.id, pending.user.id, [100], "processing");

  const summary = await preview(app, organizer.token, memory.id);
  expect(summary.statusCode).toBe(200);
  const { people } = summary.json() as { people: number };
  expect(people).toBe(2);

  const russian = (await ask(app, organizer.token, memory.id)).json() as Template[];
  for (const template of russian) {
    expect(template.story_text).toContain(named);
    expect(template.story_text).toContain("2 сентября 2026");
    expect(template.story_text).toContain(`от ${people} человек`);
    expect(template.story_text.length).toBeLessThanOrEqual(600);
  }

  expect((await speak(app, organizer.token, "en")).statusCode).toBe(200);
  const english = (await ask(app, organizer.token, memory.id)).json() as Template[];
  for (const [index, template] of english.entries()) {
    expect(template.story_text).toContain(named);
    expect(template.story_text).toContain("2 September 2026");
    expect(template.story_text).toContain(`from ${people} people`);
    expect(template.story_text.length).toBeLessThanOrEqual(600);
    // Написано руками с нуля, а не тем же текстом на другой раскладке.
    expect(template.story_text).not.toBe(russian[index]?.story_text);
  }
  expect(english.find((one) => one.id === "parents")?.music_wishes).toEqual({
    warm: expect.stringMatching(/beat/),
  });

  // Итог считает по тому, что осталось: вычеркнув единственный кадр участника,
  // организатор заказывает ролик из кадров одного человека.
  const clips = await sql<{ id: string }[]>`
    select id from media_items where memory_id = ${memory.id} and uploaded_by = ${brought.user.id}
  `;
  const narrowed = await preview(app, organizer.token, memory.id, {
    exclude_media_ids: clips.map(({ id }) => id),
  });
  expect(narrowed.statusCode).toBe(200);
  expect(narrowed.json()).toMatchObject({ people: 1 });
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
  await material(memory.id, organizer.user.id, [600, 600, 600]);

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
  await material(memory.id, organizer.user.id, [600, 600, 600]);

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

test("где заказ откажут за нехваткой материала, шаблоны отвечают тем же отказом", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const order = (memoryId: string) =>
    app.inject(
      as(organizer.token, { method: "POST", url: `/memories/${memoryId}/montages`, payload: {} }),
    );

  // Пусто; два готовых кадра и третий ещё в обработке; три видео без длины —
  // кадров хватает, а предел выходит нулём. Заказ без пожеланий отказывает во
  // всех трёх, и вход в мастер — тем же кодом и тем же телом, слово в слово.
  const empty = await createMemory(app, organizer.token);
  const thin = await createMemory(app, organizer.token);
  await material(thin.id, organizer.user.id, [600, "photo"]);
  await material(thin.id, organizer.user.id, [600], "processing");
  const blind = await createMemory(app, organizer.token);
  await material(blind.id, organizer.user.id, [null, null, null]);

  for (const [memory, ready_items] of [
    [empty, 0],
    [thin, 2],
    [blind, 3],
  ] as const) {
    const templates = await ask(app, organizer.token, memory.id);
    const placed = await order(memory.id);
    expect(templates.statusCode, `${ready_items}`).toBe(409);
    expect(templates.json()).toEqual({
      error: "not enough material for a montage",
      ready_items,
      need: 3,
    });
    expect(placed.statusCode).toBe(409);
    expect(templates.json()).toEqual(placed.json());
  }

  // Права по-прежнему раньше материала: участнику — 403, а не отказ заказа.
  const contributor = await member(app, thin.id, "contributor", organizer.user.id);
  expect((await ask(app, contributor.token, thin.id)).statusCode).toBe(403);

  // Одно фото рядом с видео без длины — и материала хватает: ответ прежний,
  // шесть шаблонов, зажатых в предел, «от 1 человека».
  await material(blind.id, organizer.user.id, ["photo"]);
  const enough = await ask(app, organizer.token, blind.id);
  expect(enough.statusCode).toBe(200);
  const templates = enough.json() as Template[];
  expect(templates).toHaveLength(6);
  for (const template of templates) {
    expect(template.target_seconds).toBe(1);
    expect(template.story_text).toContain("от 1 человека");
  }
});

test("каждый шаблон принимается заказом как есть, на любом материале и на обоих языках", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());

  // С запасом, впритык по секундам, только фото, и такой, где предел — пара
  // секунд из фото и видео без длины: во всех шаблон зажат под предел, а не
  // отвергнут. Предел — за вычетом склеек, по полсекунды на каждую.
  const stocks: [string, (number | null | "photo")[], number][] = [
    ["roomy", [600, 600, 600], 600],
    ["forty", [21, 10, 10], 40],
    ["photos", ["photo", "photo", "photo"], 6],
    ["blind", ["photo", "photo", null], 4],
  ];
  // Длины из макета: выше предела шаблон не поднимается, ниже — не опускается.
  const drawn: Record<string, number> = {
    for_myself: 180,
    quick: 60,
    report: 120,
    short_form: 30,
    parents: 150,
    dopamine: 45,
  };
  for (const language of ["ru", "en"] as const) {
    expect((await speak(app, organizer.token, language)).statusCode).toBe(200);
    for (const [name, items, ceiling] of stocks) {
      const memory = await createMemory(app, organizer.token);
      await material(memory.id, organizer.user.id, items);

      const templates = (await ask(app, organizer.token, memory.id)).json() as Template[];
      expect(templates).toHaveLength(6);
      const { people } = (await preview(app, organizer.token, memory.id)).json();

      // Тело заказа — это шаблон без `id`: id называет карточку, а не пожелание.
      for (const { id, ...payload } of templates) {
        const where = `${language} ${name} ${id}`;
        expect(payload.target_seconds, where).toBe(Math.min(ceiling, drawn[id] ?? 0));
        expect(payload.story_text, where).toContain(
          `${language === "ru" ? "от" : "from"} ${people} `,
        );
        const summary = await preview(app, organizer.token, memory.id, payload);
        expect(summary.statusCode, `${where}: ${summary.body}`).toBe(200);
        expect(summary.json().target_seconds, where).toBe(payload.target_seconds);
        const ordered = await app.inject(
          as(organizer.token, {
            method: "POST",
            url: `/memories/${memory.id}/montages`,
            payload,
          }),
        );
        expect(ordered.statusCode, `${where}: ${ordered.body}`).toBe(201);
        // Пустой объект пожеланий — это «ничего не пожелали», и в строку он не
        // пишется; непустой ложится как есть, у тех же треков.
        const { music_wishes, ...rest } = payload;
        expect(ordered.json().params, where).toEqual({
          ...rest,
          ...(Object.keys(music_wishes).length > 0 ? { music_wishes } : {}),
        });
      }
    }
  }
});
