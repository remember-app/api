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
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
    about: {
      ru: {
        name: "Клип",
        description: "Событие за двадцать секунд: лучшие кадры под музыку.",
      },
      en: {
        name: "Clip",
        description: "The event in twenty seconds: the best shots on the music.",
      },
    },
    settings: {
      targetSeconds: 20,
      dimensions: PORTRAIT,
      musicIds: [musicMediaId("all-over-again.mp3")],
      prompt:
        "Только самые сильные кадры по 1–2 секунды, склейки на бит музыки. Живой звук " +
        "почти выключить — всё держит музыка. На выразительных кадрах лёгкий наезд, " +
        "склейки резкие, без длинных переходов. Сюжета нет: начать с сильного кадра и " +
        "закончить самым сильным.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02",
    about: {
      ru: {
        name: "Трейлер",
        description: "Зацепить с первых секунд и не показать главного.",
      },
      en: {
        name: "Trailer",
        description: "Hook from the first seconds and never show the payoff.",
      },
    },
    settings: {
      targetSeconds: 30,
      dimensions: PORTRAIT,
      musicIds: [musicMediaId("all-over-again.mp3")],
      prompt:
        "Интрига: начать с одной цепляющей детали и вести к нарастанию. Чем дальше, тем " +
        "короче кадры и резче склейки, в конце кульминация под музыку. Лучший момент не " +
        "показывать целиком. Живой звук — короткими акцентами, ведёт музыка.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03",
    about: {
      ru: {
        name: "Лучшие моменты",
        description: "Без сюжета — просто самые яркие кадры подряд.",
      },
      en: {
        name: "Highlights",
        description: "No story — just the brightest shots one after another.",
      },
    },
    settings: {
      targetSeconds: 45,
      dimensions: PORTRAIT,
      musicIds: [musicMediaId("drifting-pines.mp3")],
      prompt:
        "Без сюжета и без хронологии: только кадры, которые работают сами по себе — смех, " +
        "действие, реакции, красивые виды. По 2–4 секунды, резкие склейки, иногда короткое " +
        "наплывание. Живой звук оставлять там, где он и есть момент (смех, аплодисменты, " +
        "крик), в остальном приглушать. Музыка играет подряд, без остановок.",
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
      musicIds: [musicMediaId("drifting-pines.mp3")],
      prompt:
        "Настоящая история с дугой: начать с общего плана или тихой детали, показать людей " +
        "и место, пройти через событие, дать реакциям подышать, закончить сильным спокойным " +
        "кадром. Кадры по 3–6 секунд, дольше, если момент того стоит. Живой звук и речь — " +
        "там, где они несут историю, в остальном музыка. Наезды и наплывания мягкие, " +
        "быстрой резки нет.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb05",
    about: {
      ru: {
        name: "Хроника дня",
        description: "Как всё было на самом деле — по порядку и без прикрас.",
      },
      en: {
        name: "Chronicle",
        description: "How it really went — in order and without decoration.",
      },
    },
    settings: {
      targetSeconds: 90,
      dimensions: LANDSCAPE,
      musicIds: [musicMediaId("thinking-of-home.mp3")],
      prompt:
        "Строго в порядке съёмки, от начала события к концу, и каждый кадр показывать " +
        "достаточно долго, чтобы было видно, что происходит. Ведёт живой звук, музыка тихо " +
        "под ним и никогда не закрывает речь. Без наездов и без красивых переходов: только " +
        "резкие склейки, укорачивать кадр — только если в нём ничего не происходит.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb06",
    about: {
      ru: {
        name: "Для близких",
        description: "Про людей: лица, улыбки, объятия.",
      },
      en: {
        name: "For family",
        description: "About the people: faces, smiles, embraces.",
      },
    },
    settings: {
      targetSeconds: 60,
      dimensions: PORTRAIT,
      musicIds: [musicMediaId("family-music-andriig.mp3")],
      prompt:
        "Кадры с лицами, взглядами, смехом и объятиями — важнее общих планов и пустых " +
        "видов. Медленный темп, кадры по 3–5 секунд, мягкие наплывания. Живой звук поднять " +
        "там, где говорят, смеются или поют, музыка тихо под ним. Закончить самым тёплым " +
        "человеческим моментом.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb07",
    about: {
      ru: {
        name: "Атмосфера",
        description: "Место и настроение: детали, свет, без суеты.",
      },
      en: {
        name: "Mood",
        description: "The place and the mood: details, light, no rush.",
      },
    },
    settings: {
      targetSeconds: 30,
      dimensions: PORTRAIT,
      musicIds: [musicMediaId("thinking-of-home.mp3")],
      prompt:
        "Настроение, а не события: детали, свет, фактуры, руки, столы, украшения, куски " +
        "места — мало лиц и никакой последовательности. Медленные кадры по 4–6 секунд, " +
        "плавные наезды, мягкие затемнения. Живой звук тихо под музыкой: настроение держат " +
        "музыка и картинка, а не то, что люди говорят.",
    },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb08",
    about: {
      ru: {
        name: "Всё вместе",
        description: "Длинный фильм, куда войдёт почти всё, что сняли.",
      },
      en: {
        name: "Everything",
        description: "A long film that keeps nearly everything that was shot.",
      },
    },
    settings: {
      targetSeconds: 180,
      dimensions: LANDSCAPE,
      musicIds: [musicMediaId("family-music-andriig.mp3")],
      prompt:
        "Длинная запись события: вобрать столько кадров, сколько позволяет время, примерно " +
        "по порядку, и каждому дать время быть увиденным. Не выбрасывать ничего, кроме " +
        "повторов и негодного. Живой звук, речь и музыка чередуются. Только резкие склейки, " +
        "минимум движения, ничего нарядного.",
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
