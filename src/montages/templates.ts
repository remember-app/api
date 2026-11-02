import type { FastifyInstance } from "fastify";
import type { Language } from "../auth/session.ts";
import type { musicTracks } from "./music.ts";
import { checkOrder } from "./order.ts";
import type { templateIds } from "./row.ts";

type Facts = {
  title: string;
  dates: string;
  people: string;
};
type Track = (typeof musicTracks)[number];
type Template = {
  id: (typeof templateIds)[number];
  seconds: number;
  orientation: "landscape" | "portrait";
  tracks: Track[];
  story: Record<Language, (facts: Facts) => string>;
  wishes?: Record<Language, Partial<Record<Track, string>>>;
};
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
const spellDates = (language: Language, start: Date, end: Date | null) =>
  new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(start, end ?? start);
const spellPeople = (language: Language, count: number) =>
  language === "ru"
    ? `${count} ${count % 10 === 1 && count % 100 !== 11 ? "человека" : "человек"}`
    : `${count} ${count === 1 ? "person" : "people"}`;
export function montageTemplateRoutes(app: FastifyInstance) {
  app.get<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId/montage-templates",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });
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
        target_seconds: Math.min(Math.max(seconds, min_seconds), max_seconds),
        orientation,
        music_tracks: [...tracks],
        music_wishes: { ...wishes?.[language] },
      }));
    },
  );
}
