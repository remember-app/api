import { sql } from "../../../src/integrations/db/index.ts";

const TEMPLATES = [
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
    name: "Быстрый клип",
    settings: {
      targetSeconds: 15,
      prompt: "Короткий динамичный клип о самом ярком моменте.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02",
    name: "Кино",
    settings: {
      targetSeconds: 60,
      prompt: "Тёплый фильм с историей, спокойным ритмом и титрами.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03",
    name: "Репортаж",
    settings: {
      targetSeconds: 45,
      prompt: "Репортаж о том, как прошёл день, от начала до конца.",
      dimensions: { width: 1920, height: 1080 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04",
    name: "Для родителей",
    settings: {
      targetSeconds: 30,
      prompt: "Мягкий семейный фильм о детях и близких.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb05",
    name: "История",
    settings: {
      targetSeconds: 45,
      prompt: "Рассказ от первого лица о том, как прошёл вечер.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb06",
    name: "Атмосфера",
    settings: {
      targetSeconds: 20,
      prompt: "Медленные планы и детали, без суеты.",
      dimensions: { width: 1080, height: 1920 },
      musicIds: [],
    },
  },
];

export async function seedMontageTemplates(): Promise<void> {
  for (const template of TEMPLATES) {
    await sql`
      insert into montage_templates (id, name, settings, reference_media_id)
      values (${template.id}, ${template.name}, ${sql.json(template.settings)}, null)
      on conflict (id) do update
      set name = excluded.name,
          settings = excluded.settings,
          reference_media_id = excluded.reference_media_id
    `;
    console.log(`essentials: template ${template.name}`);
  }
}
