import { sql } from "../../../src/integrations/db/index.ts";
import { musicMediaId } from "./music.manifest.ts";

type Template = {
  id: string;
  about: Record<"ru" | "en", { name: string; description: string }>;
  settings: {
    targetSeconds: number;
    prompt: string;
    dimensions: { width: number; height: number };
    musicIds: string[];
  };
};

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

const TEMPLATES: Template[] = [
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb09",
    about: {
      ru: {
        name: "В семейный чат",
        description: "Тёплый ролик для родных: лица, улыбки и голоса без спешки.",
      },
      en: {
        name: "For the family chat",
        description: "A warm cut for the relatives: faces, smiles and voices, unhurried.",
      },
    },
    settings: {
      targetSeconds: 45,
      dimensions: PORTRAIT,
      musicIds: [
        musicMediaId("family-music-andriig.mp3"),
        musicMediaId("forever-in-my-heart.mp3"),
        musicMediaId("i-love-you-grandma.mp3"),
        musicMediaId("our-journey.mp3"),
      ],
      prompt:
        "Ролик для семейного чата: его будут смотреть с телефона, часто старшие родственники. " +
        "Только тёплые человеческие кадры: лица крупно, улыбки, объятия, застолье, дети, " +
        "поздравления. Спокойный темп, кадры по 3–5 секунд, мягкие наплывания, без быстрой " +
        "резки. Живой звук поднять там, где говорят, смеются или поздравляют; музыка тихо под " +
        "ним и никогда не закрывает голоса. Порядок примерно по ходу праздника: сборы, встреча, " +
        "застолье, самый тёплый момент — в конце. Ничего лишнего и никакой суеты.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb10",
    about: {
      ru: {
        name: "Reels",
        description: "Вертикальный ролик для Reels: хук в первую секунду и монтаж на бит.",
      },
      en: {
        name: "Reels",
        description: "A vertical reel: hook in the first second, cut on the beat.",
      },
    },
    settings: {
      targetSeconds: 20,
      dimensions: PORTRAIT,
      musicIds: [
        musicMediaId("hip-hop-02.mp3"),
        musicMediaId("c-b-p-d.mp3"),
        musicMediaId("karma.mp3"),
      ],
      prompt:
        "Вертикальный ролик для Reels. Первая секунда — самый сильный кадр, дальше не " +
        "отпускать: кадры по 0,5–1,5 секунды, склейки строго на бит музыки, к концу темп " +
        "нарастает. Живой звук почти выключить, ритм держит музыка. Только кадры, которые " +
        "работают сами по себе: действие, эмоции, движение, крупные лица; ничего статичного, " +
        "пустого и затянутого. На самых сильных кадрах — короткий резкий наезд. Сюжета нет: " +
        "открыть самым громким моментом, закончить вторым по силе.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb11",
    about: {
      ru: {
        name: "Для себя",
        description: "Личная память о вечере: по-честному и без спешки, не на показ.",
      },
      en: {
        name: "Just for me",
        description: "A personal memory of the evening: honest and unhurried, not for show.",
      },
    },
    settings: {
      targetSeconds: 90,
      dimensions: LANDSCAPE,
      musicIds: [
        musicMediaId("thinking-of-home.mp3"),
        musicMediaId("these-nights.mp3"),
        musicMediaId("sweet-september.mp3"),
        musicMediaId("day-dreamin-with-u.mp3"),
      ],
      prompt:
        "Ролик для себя, не на показ: сохранить вечер таким, каким он был. Порядок по ходу " +
        "съёмки, каждый кадр держать столько, сколько нужно, чтобы вспомнить момент — 3–6 " +
        "секунд. Не резать то, что дорого, даже если рядом есть кадр красивее. Живой звук и " +
        "разговоры сохранить, музыку держать тихо и только фоном. Никаких наездов и нарядных " +
        "переходов: простые склейки. Пропустить пустые и повторяющиеся кадры, но не выбрасывать " +
        "ничего характерного для вечера.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02",
    about: {
      ru: {
        name: "Тизер",
        description: "Зацепить с первых секунд и не показать главного.",
      },
      en: {
        name: "Teaser",
        description: "Hook from the first seconds and never show the payoff.",
      },
    },
    settings: {
      targetSeconds: 30,
      dimensions: PORTRAIT,
      musicIds: [
        musicMediaId("i-wont-surrender.mp3"),
        musicMediaId("epical-drums-01.mp3"),
        musicMediaId("epical-drums-05.mp3"),
      ],
      prompt:
        "Интрига: начать с одной цепляющей детали и вести к нарастанию. Чем дальше, тем " +
        "короче кадры и резче склейки, в конце кульминация под музыку. Лучший момент не " +
        "показывать целиком и не выдавать финал. Живой звук — короткими акцентами, ведёт " +
        "музыка.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb12",
    about: {
      ru: {
        name: "Блуперс",
        description: "Неудачные дубли, нелепые лица и моменты не туда — под весёлую музыку.",
      },
      en: {
        name: "Bloopers",
        description: "Failed takes, silly faces and moments going wrong, on cheerful music.",
      },
    },
    settings: {
      targetSeconds: 40,
      dimensions: PORTRAIT,
      musicIds: [
        musicMediaId("bob.mp3"),
        musicMediaId("fun-and-games.mp3"),
        musicMediaId("kidding-around.mp3"),
      ],
      prompt:
        "Смешное: провалы, неудачные дубли, нелепые лица, кто-то не туда посмотрел, кто-то " +
        "уронил, кто-то влез в кадр. Искать нелепость и неожиданность, а не красоту: " +
        "идеальный кадр сюда не нужен. Коротко и резко: 1–2 секунды, склейки встык, на самом " +
        "смешном — резкий наезд на лицо. Живой звук поднять там, где смех, вскрик, ругань или " +
        "неловкая тишина; музыка весёлая и лёгкая. Финальный кадр — самый нелепый.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb13",
    about: {
      ru: {
        name: "Друзьям",
        description: "Вечер без приличий: бар, танцы, ржач и живой звук на полную.",
      },
      en: {
        name: "For the friends",
        description: "The night without manners: bar, dancing, laughter and live sound loud.",
      },
    },
    settings: {
      targetSeconds: 45,
      dimensions: PORTRAIT,
      musicIds: [
        musicMediaId("funkee-monkeee.mp3"),
        musicMediaId("funky-martian.mp3"),
        musicMediaId("this-our-year.mp3"),
        musicMediaId("c-b-p-d.mp3"),
      ],
      prompt:
        "Ролик для своих: громко, грязно и весело. Танцы, бар, объятия, крики, ржач, лица " +
        "друзей крупно. Кадры по 1–2,5 секунды, склейки резкие, ритм держат живой звук и " +
        "музыка наравне. Живой звук поднять до максимума там, где смех и крик; музыку не " +
        "глушить. Показать всех, кто был, никого не забыть. Порядок — как шёл вечер: начало, " +
        "разгар, самый угарный момент в конце. Никакой сентиментальности и долгих планов.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb14",
    about: {
      ru: {
        name: "Коротко",
        description: "Самое главное за пятнадцать секунд.",
      },
      en: {
        name: "Short",
        description: "The essence in fifteen seconds.",
      },
    },
    settings: {
      targetSeconds: 15,
      dimensions: PORTRAIT,
      musicIds: [
        musicMediaId("follow-me-home.mp3"),
        musicMediaId("positive-energy.mp3"),
        musicMediaId("sounds-good.mp3"),
      ],
      prompt:
        "Очень коротко: пятнадцать секунд, не больше. Пять-восемь лучших кадров по 1–2 " +
        "секунды, склейки на бит, без переходов и пауз. Начать с самого сильного кадра и " +
        "закончить не менее сильным. Живой звук — только на одном-двух акцентах (смех, крик, " +
        "аплодисменты), остальное держит музыка. Каждый кадр должен что-то показывать: " +
        "ничего лишнего и ничего статичного.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04",
    about: {
      ru: {
        name: "Фильм",
        description: "Полная история события: начало, развитие, финал.",
      },
      en: {
        name: "Film",
        description: "The full story of the event: beginning, middle, ending.",
      },
    },
    settings: {
      targetSeconds: 120,
      dimensions: LANDSCAPE,
      musicIds: [
        musicMediaId("drifting-pines.mp3"),
        musicMediaId("we-will-get-it.mp3"),
        musicMediaId("a-new-life.mp3"),
        musicMediaId("lifes-a-movie.mp3"),
      ],
      prompt:
        "Настоящая история с дугой: начать с общего плана или тихой детали, показать людей " +
        "и место, пройти через событие, дать реакциям подышать, закончить сильным спокойным " +
        "кадром. Кадры по 3–6 секунд, дольше, если момент того стоит. Живой звук и речь — " +
        "там, где они несут историю, в остальном музыка. Наезды и наплывания мягкие, " +
        "быстрой резки нет.",
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

  const ids = TEMPLATES.map((template) => template.id);
  await sql`
    delete from montage_templates
    where id::text <> all(${ids})
  `;
}
