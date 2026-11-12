import { sql } from "../../../src/integrations/db/index.ts";

const TEMPLATES = [
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
    about: {
      ru: {
        name: "Быстрый клип",
        description: "Короткий динамичный клип о самом ярком моменте.",
      },
      en: {
        name: "Quick clip",
        description: "A short, dynamic clip about the brightest moment.",
      },
    },
    settings: {
      targetSeconds: 15,
      prompt: "Короткий динамичный клип о самом ярком моменте.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02",
    about: {
      ru: {
        name: "Кино",
        description: "Тёплый фильм с историей, спокойным ритмом и титрами.",
      },
      en: {
        name: "Film",
        description: "A warm film with a story, an unhurried pace and captions.",
      },
    },
    settings: {
      targetSeconds: 60,
      prompt: "Тёплый фильм с историей, спокойным ритмом и титрами.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03",
    about: {
      ru: {
        name: "Репортаж",
        description: "Репортаж о том, как прошёл день, от начала до конца.",
      },
      en: {
        name: "Report",
        description: "A report on how the day went, from start to finish.",
      },
    },
    settings: {
      targetSeconds: 45,
      prompt: "Репортаж о том, как прошёл день, от начала до конца.",
      dimensions: { width: 1920, height: 1080 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04",
    about: {
      ru: {
        name: "Для родителей",
        description: "Мягкий семейный фильм о детях и близких.",
      },
      en: {
        name: "For parents",
        description: "A gentle family film about children and those close to you.",
      },
    },
    settings: {
      targetSeconds: 30,
      prompt: "Мягкий семейный фильм о детях и близких.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb05",
    about: {
      ru: {
        name: "История",
        description: "Рассказ от первого лица о том, как прошёл вечер.",
      },
      en: {
        name: "Story",
        description: "A first-person story of how the evening went.",
      },
    },
    settings: {
      targetSeconds: 45,
      prompt: "Рассказ от первого лица о том, как прошёл вечер.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb06",
    about: {
      ru: {
        name: "Атмосфера",
        description: "Медленные планы и детали, без суеты.",
      },
      en: {
        name: "Atmosphere",
        description: "Slow shots and details, no rush.",
      },
    },
    settings: {
      targetSeconds: 20,
      prompt: "Медленные планы и детали, без суеты.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb07",
    about: {
      ru: {
        name: "Трейлер",
        description: "Короткий трейлер с нарастанием и кульминацией в финале.",
      },
      en: {
        name: "Trailer",
        description: "A short trailer that builds up to a climax at the end.",
      },
    },
    settings: {
      targetSeconds: 30,
      prompt: "Короткий трейлер с нарастанием и кульминацией в финале.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb08",
    about: {
      ru: {
        name: "Хроника",
        description: "Спокойная хроника события по порядку, от начала до конца.",
      },
      en: {
        name: "Chronicle",
        description: "A calm chronicle of the event in order, from start to finish.",
      },
    },
    settings: {
      targetSeconds: 75,
      prompt: "Спокойная хроника события по порядку, от начала до конца.",
      dimensions: { width: 1920, height: 1080 },
      musicIds: [],
    },
  },
];

export async function seedMontageTemplates(): Promise<void> {
  for (const template of TEMPLATES) {
    await sql`
      insert into montage_templates (id, about, settings, reference_media_id)
      values (${template.id}, ${sql.json(template.about)}, ${sql.json(template.settings)}, null)
      on conflict (id) do update
      set about = excluded.about,
          settings = excluded.settings,
          reference_media_id = excluded.reference_media_id
    `;
    console.log(`essentials: template ${template.about.en.name}`);
  }
}
