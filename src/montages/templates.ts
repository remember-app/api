import type { FastifyInstance } from "fastify";
import type { Language } from "../auth/session.ts";
import type { musicTracks } from "./music.ts";
import { checkOrder } from "./order.ts";
import type { templateIds } from "./row.ts";

/**
 * Шесть готовых роликов на выбор (doc-03: «Шаблон — это текст истории, музыка,
 * длина и формат разом»). Экран — design/screens/MontageTemplate.html: шесть
 * карточек в этом порядке и «Настроить самому» под ними.
 *
 * Шаблон здесь — это заранее заполненное тело заказа и ничего больше: что
 * маршрут отдал, то приложение и шлёт в `POST /memories/:memoryId/montages`,
 * при желании поправив руками по дороге (doc-03, «Автопилот»). Поэтому своих
 * строк в базе у шаблонов нет: всё, из чего шаблон состоит, уже описано
 * заказом. От шаблона ролику остаётся только `id` карточки — заказ шлёт его
 * полем `template`, чтобы сведения ролика потом сказали, с чего он начался.
 *
 * «Настроить самому» сюда не входит — это пустой заказ, про который маршруту
 * нечего сказать. Названия и подписи карточек тоже: они живут в словаре
 * приложения по `id` и переводятся вместе с остальным интерфейсом (doc-8).
 * Сервер отдаёт только то, что сам знает про это воспоминание.
 */

/** Название воспоминания, даты и число тех, кто нёс кадры, — для заготовки. */
type Facts = { title: string; dates: string; people: string };

type Track = (typeof musicTracks)[number];

type Template = {
  id: (typeof templateIds)[number];
  /** Длина из макета; на деле зажимается по материалу воспоминания. */
  seconds: number;
  orientation: "landscape" | "portrait";
  tracks: Track[];
  story: Record<Language, (facts: Facts) => string>;
  /**
   * Пожелание к треку — у того трека шаблона, о котором оно, и только там,
   * где оно что-то добавляет.
   */
  wishes?: Record<Language, Partial<Record<Track, string>>>;
};

/**
 * Шесть, в порядке макета. Музыка — с полки воркера (`musicTracks`), выбрана по
 * настроению карточки; менять её значит править эту таблицу и ничего больше.
 *
 * Обе истории написаны руками, английская — не перевод русской (doc-8). Голос —
 * образца из макета (MontageStory.html): что за ролик, какой темп, что главное,
 * чего избегать. Подставляется только то, что сервер знает сам: название как
 * есть, даты и сколько человек несли кадры. Ни имён, ни повода — про свадьбу
 * из макета знает организатор, а не api.
 *
 * Каждая заготовка написана так, чтобы с самым длинным названием (200 символов,
 * потолок поля) уложиться в 600 — столько принимает поле «История ролика» на
 * экране, куда этот текст и приедет (design/screens/MontageStory.html). Обрезки
 * поэтому нет нигде: короткими их держит тест, а не код.
 */
const templates: Template[] = [
  {
    id: "for_myself",
    seconds: 180,
    orientation: "landscape",
    tracks: ["calm"],
    story: {
      ru: ({ title, dates, people }) =>
        `Ролик для себя о «${title}». ${dates}, кадры от ${people}. ` +
        "Спокойно и без спешки, как перелистывают альбом: кадр появился — дай его рассмотреть. " +
        "Главное — живые лица и мелочи, которые помнит только тот, кто там был. " +
        "Порядок — как всё и шло. Ничего показного, монтаж не должен подгонять.",
      en: ({ title, dates, people }) =>
        `A movie just for me about “${title}”. ${dates}, footage from ${people}. ` +
        "Unhurried, the way you turn the pages of an album: let every shot sit long enough " +
        "to look at. What matters is faces, and the small things only someone who was there " +
        "remembers. Keep it in the order it happened. Nothing showy, and never rush me.",
    },
  },
  {
    id: "quick",
    seconds: 60,
    orientation: "landscape",
    tracks: ["bright"],
    story: {
      ru: ({ title, dates, people }) =>
        `Быстрый ролик о «${title}». ${dates}, кадры от ${people}. ` +
        "Бодро и в ритм: кадры короткие, движение не останавливается ни на секунду. " +
        "Бери самое громкое — смех, движение, толпу. Спокойное и статичное не бери вовсе. " +
        "Минута, за которую видно всё.",
      en: ({ title, dates, people }) =>
        `A quick one about “${title}”. ${dates}, footage from ${people}. ` +
        "Upbeat and on the beat: short shots, the movement never stops. Take the loudest of it " +
        "— laughter, motion, a room full of people. Leave anything still or slow out entirely. " +
        "One minute that shows the whole thing.",
    },
  },
  {
    id: "report",
    seconds: 120,
    orientation: "landscape",
    tracks: ["calm"],
    story: {
      ru: ({ title, dates, people }) =>
        `Отчётный ролик о «${title}». ${dates}, кадры от ${people}. ` +
        "Ровно и по порядку, от начала к концу. Каждое заметное место — по разу, " +
        "общие планы важнее случайных крупных. Склейки спокойные, темп один и тот же, " +
        "без шуток и без резкости. Такой, чтобы его можно было показать кому угодно.",
      en: ({ title, dates, people }) =>
        `A straight record of “${title}”. ${dates}, footage from ${people}. ` +
        "Even and in order, beginning to end. Every part of it once, wide shots ahead of " +
        "whatever close-up happened to be taken. Calm cuts, one steady pace, no jokes and no " +
        "tricks. Something that can be put in front of anyone.",
    },
  },
  {
    id: "short_form",
    seconds: 30,
    orientation: "portrait",
    tracks: ["bright"],
    story: {
      ru: ({ title, dates, people }) =>
        `Вертикальный ролик о «${title}» для ленты. ${dates}, кадры от ${people}. ` +
        "Первая секунда решает всё: начни с самого сильного кадра и дальше не отпускай. " +
        "Кадры короткие, темп высокий, ничего затянутого. Люди крупно и по центру. " +
        "Конец такой, чтобы захотелось посмотреть ещё раз.",
      en: ({ title, dates, people }) =>
        `A vertical cut of “${title}” for the feed. ${dates}, footage from ${people}. ` +
        "The first second decides everything: open on the strongest shot and never let go. " +
        "Short shots, high pace, nothing that drags. People big and centred in frame. " +
        "End it so they watch it again.",
    },
  },
  {
    id: "parents",
    seconds: 150,
    orientation: "landscape",
    tracks: ["warm"],
    story: {
      ru: ({ title, dates, people }) =>
        `Ролик для родителей о «${title}». ${dates}, кадры от ${people}. ` +
        "Темп спокойный, каждый кадр держится подольше, чтобы успеть рассмотреть. " +
        "Главное — лица и то, как люди рядом друг с другом: объятия, разговоры, общий стол. " +
        "Начни с тихого, к финалу оставь самое тёплое. Без резких склеек, мелькания и шума.",
      en: ({ title, dates, people }) =>
        `A movie for the parents about “${title}”. ${dates}, footage from ${people}. ` +
        "Take it slow — hold each shot long enough to take it in. What matters is faces, and " +
        "people being with each other: hugs, talking, everyone round one table. Start quiet, " +
        "save the warmest thing for the end. No hard cuts, no flicker, nothing loud.",
    },
    wishes: {
      ru: { warm: "Склейки под музыку, но мягкие — в такт, а не в удар." },
      en: { warm: "Cut with the music, but gently — on the beat, not on the hit." },
    },
  },
  {
    id: "dopamine",
    seconds: 45,
    orientation: "portrait",
    tracks: ["bright", "road"],
    story: {
      ru: ({ title, dates, people }) =>
        `Вертикальный ролик о «${title}» на полной громкости. ${dates}, кадры от ${people}. ` +
        "Максимально резко: короткие кадры один за другим, ни одной паузы. " +
        "Бери только пики — прыжки, крики, брызги, свет. Спокойное вырезай целиком. " +
        "Пусть к концу кажется, что всё это уместилось в одну минуту.",
      en: ({ title, dates, people }) =>
        `“${title}”, vertical and at full volume. ${dates}, footage from ${people}. ` +
        "As sharp as it gets: short shots back to back, not one pause anywhere. Only the peaks " +
        "— jumps, shouting, splashes, light. Cut everything calm out completely. " +
        "By the end it should feel like all of it happened in a minute.",
    },
    // Два трека, и у каждого своя роль: первый разгоняет, со второго — самая
    // гуща. Поэтому пожелание у каждого своё, а общее у них — склейки в бит.
    wishes: {
      ru: {
        bright: "Этот разгоняет. Склейки строго в бит.",
        road: "С этого — самая гуща. Склейки строго в бит.",
      },
      en: {
        bright: "This one builds it up. Cut strictly on the beat.",
        road: "This one is where it goes wild. Cut strictly on the beat.",
      },
    },
  },
];

/**
 * Даты воспоминания словами — одно число или период (doc-8: «даты выводятся по
 * выбранному языку»). `formatRange` сам сводит период к одному числу, когда
 * начало и конец приходятся на один день, и не повторяет месяц внутри одного
 * месяца — «2–5 сентября 2026 г.», а не «2 сентября — 5 сентября».
 *
 * ponytail: день считается по UTC. Инстант в базе пришёл со смещением того, кто
 * заводил воспоминание, и вечернее событие в UTC+3 ляжет в тот же день, а
 * ночное — в предыдущий. Часового пояса воспоминание не хранит; когда начнёт,
 * сюда встанет он.
 */
const spellDates = (language: Language, start: Date, end: Date | null) =>
  new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(start, end ?? start);

/**
 * Сколько человек несли кадры — в той форме, в какой стоит в заготовках, то
 * есть после «от» и «from». Русское «от 1 человека» и «от 5 человек» — родительный
 * падеж, и 11 в нём ведёт себя как 5, а не как 1.
 */
const spellPeople = (language: Language, count: number) =>
  language === "ru"
    ? `${count} ${count % 10 === 1 && count % 100 !== 11 ? "человека" : "человек"}`
    : `${count} ${count === 1 ? "person" : "people"}`;

/**
 * Монтируется из `buildApp` после `memoriesPlugin` — как и заказ, за проверкой
 * членства и с той же проверкой роли поверх.
 */
export function montageTemplateRoutes(app: FastifyInstance) {
  // Шесть карточек экрана «Каким будет ролик». Только организатору: заказывает
  // ролик он один (architecture.md, «Проверка прав»), а шаблон — это заказ,
  // заполненный заранее. Не участнику проверка членства уже ответила 404.
  app.get<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/montage-templates",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });

      // Взвешено как заказ без пожеланий — вычеркнутых кадров на этом шаге ещё
      // нет. Там, где «Начать монтаж» всё равно откажет за нехваткой материала,
      // мастер получает тот же отказ сразу, а не шесть карточек «от 0 человек».
      // Предел и «от N человек» — оттуда же, по всему готовому материалу, кроме
      // отсеянного (`materialLeft`); итог заказа пересчитает оба по тому, что
      // останется и что организатор вернёт из отсева. Люди — тем же счётом,
      // что `people` на итоге, иначе два соседних экрана назовут разные числа.
      const checked = await checkOrder(memory.id, null);
      if (!("params" in checked)) return reply.code(checked.code).send(checked.body);
      const { min_seconds, max_seconds, people } = checked.left;

      const language = request.user.language;
      const facts = {
        title: memory.title,
        dates: spellDates(language, memory.event_start, memory.event_end),
        people: spellPeople(language, people),
      };
      return templates.map(({ id, seconds, orientation, tracks, story, wishes }) => ({
        id,
        story_text: story[language](facts),
        // Длина шаблона в пределах этого воспоминания: три минуты при пределе в
        // сорок секунд — это сорок. Нижний край держится тем же зажимом,
        // хотя сегодня до него не дотягивается ни один шаблон.
        target_seconds: Math.min(Math.max(seconds, min_seconds), max_seconds),
        orientation,
        music_tracks: [...tracks],
        // Поле есть всегда, `{}` там, где сказать нечего, — чтобы приложению не
        // гадать, отдали его или забыли.
        music_wishes: { ...wishes?.[language] },
      }));
    },
  );
}
