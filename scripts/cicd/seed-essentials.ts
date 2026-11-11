import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../../src/integrations/db/index.ts";
import { putObject, storageConfigured } from "../../src/integrations/storage/s3.ts";
import {
  ANALYSIS_PRICE_KEY,
  type AnalysisPrice,
  INVITE_REWARDS_KEY,
  type InviteRewards,
} from "../../src/services/settings/defaults.ts";
import { SYSTEM_MEDIA, systemMediaKey } from "../../src/services/system/media.ts";

const ASSETS =
  process.env.ASSETS_DIR ?? fileURLToPath(new URL("../../../../assets", import.meta.url));

const INVITE_REWARDS: InviteRewards = {
  sender: { tokens: 50, storageBytes: 5 * 1024 ** 3 },
  invitee: { tokens: 50, storageBytes: 5 * 1024 ** 3 },
};

const ANALYSIS_PRICE: AnalysisPrice = { tokens: 1 };

const PROVIDER_RATES_KEY = "ai.providerRates";

const PROVIDER_RATES = {
  "gemini-3.8-flash": {
    inputPerMillionUsd: 0.75,
    outputPerMillionUsd: 3.75,
    cachedInputPerMillionUsd: 0.075,
  },
};

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

const MUSIC = [
  { name: "とてつもなくいい!", author: "VISUAL PROGRAMMING LTD", file: "vp-01.mp3" },
  { name: "eclipse ゼロ重力", author: "VISUAL PROGRAMMING LTD", file: "vp-02.mp3" },
  { name: "neon flamingos", author: "VISUAL PROGRAMMING LTD", file: "vp-03.mp3" },
  { name: "shanghai✧kicks", author: "VISUAL PROGRAMMING LTD", file: "vp-04.mp3" },
  { name: "midnight venture", author: "VISUAL PROGRAMMING LTD", file: "vp-05.mp3" },
  { name: "来世ripe", author: "VISUAL PROGRAMMING LTD", file: "vp-06.mp3" },
  { name: "reinventing yourself❢", author: "VISUAL PROGRAMMING LTD", file: "vp-07.mp3" },
  { name: "真剣にファンカデリック", author: "VISUAL PROGRAMMING LTD", file: "vp-08.mp3" },
  { name: "midnight venture II", author: "VISUAL PROGRAMMING LTD", file: "vp-09.mp3" },
  { name: "THE 涼しい AGENDA", author: "VISUAL PROGRAMMING LTD", file: "vp-10.mp3" },
  { name: "dokyunブルース", author: "VISUAL PROGRAMMING LTD", file: "vp-11.mp3" },
  { name: "ビジュアルFINAL", author: "VISUAL PROGRAMMING LTD", file: "vp-12.mp3" },
  { name: "Aria", author: "Kimiko Ishizaka", file: "goldberg-aria.mp3" },
  { name: "Variatio 1", author: "Kimiko Ishizaka", file: "goldberg-var01.mp3" },
  { name: "Variatio 3", author: "Kimiko Ishizaka", file: "goldberg-var03.mp3" },
  { name: "Variatio 5", author: "Kimiko Ishizaka", file: "goldberg-var05.mp3" },
  { name: "Variatio 7", author: "Kimiko Ishizaka", file: "goldberg-var07.mp3" },
  { name: "Variatio 10", author: "Kimiko Ishizaka", file: "goldberg-var10.mp3" },
  { name: "Variatio 13", author: "Kimiko Ishizaka", file: "goldberg-var13.mp3" },
  { name: "Variatio 21", author: "Kimiko Ishizaka", file: "goldberg-var21.mp3" },
];

const TRACK_SECONDS = 60;

const suffix = (index: number): string => String(index + 1).padStart(12, "0");

async function main(): Promise<void> {
  if (!storageConfigured()) throw new Error("essentials: S3 is not configured");
  for (const entry of SYSTEM_MEDIA) {
    const key = systemMediaKey(entry);
    const file = readFileSync(
      join(
        ASSETS,
        "system",
        entry.name.startsWith("onboarding") ? "onboarding" : "cover",
        entry.file,
      ),
    );
    await putObject(key, file, entry.contentType);
    await sql`
      insert into media_items (id, kind, storage_key, uploaded_by, format, bytes, width, height)
      values (
        ${entry.mediaId},
        'photo',
        ${key},
        null,
        ${entry.format},
        ${file.length},
        ${entry.width},
        ${entry.height}
      )
      on conflict (id) do update
      set storage_key = excluded.storage_key,
          format = excluded.format,
          bytes = excluded.bytes,
          width = excluded.width,
          height = excluded.height
    `;
    console.log(`essentials: ${entry.name} ${entry.mediaId}`);
  }

  for (const [index, track] of MUSIC.entries()) {
    const mediaId = `cccccccc-cccc-4ccc-8ccc-${suffix(index)}`;
    const songId = `dddddddd-dddd-4ddd-8ddd-${suffix(index)}`;
    const key = `remember/mp3/${mediaId}`;
    const file = readFileSync(
      join(ASSETS, "music", track.file.startsWith("vp-") ? "vp" : "goldberg", track.file),
    );
    await putObject(key, file, "audio/mpeg");
    await sql`
      insert into media_items (
        id, kind, storage_key, uploaded_by, format, bytes, duration
      )
      values (
        ${mediaId}, 'audio', ${key}, null, 'mp3', ${file.length}, ${TRACK_SECONDS}
      )
      on conflict (id) do update
      set storage_key = excluded.storage_key,
          format = excluded.format,
          bytes = excluded.bytes,
          duration = excluded.duration
    `;
    await sql`
      insert into songs (id, name, author, media_id, project_id, uploaded_by)
      values (${songId}, ${track.name}, ${track.author}, ${mediaId}, null, null)
      on conflict (id) do update
      set name = excluded.name,
          author = excluded.author,
          media_id = excluded.media_id
    `;
    console.log(`essentials: track ${track.name}`);
  }

  await sql`
    insert into settings (key, value)
    values (${INVITE_REWARDS_KEY}, ${sql.json(INVITE_REWARDS)})
    on conflict (key) do nothing
  `;
  console.log(`essentials: setting ${INVITE_REWARDS_KEY}`);
  await sql`
    insert into settings (key, value)
    values (${ANALYSIS_PRICE_KEY}, ${sql.json(ANALYSIS_PRICE)})
    on conflict (key) do nothing
  `;
  console.log(`essentials: setting ${ANALYSIS_PRICE_KEY}`);
  await sql`
    insert into settings (key, value)
    values (${PROVIDER_RATES_KEY}, ${sql.json(PROVIDER_RATES)})
    on conflict (key) do nothing
  `;
  console.log(`essentials: setting ${PROVIDER_RATES_KEY}`);

  for (const template of TEMPLATES) {
    await sql`
      insert into montage_templates (id, name, settings, reference_media_id)
      values (${template.id}, ${template.name}, ${sql.json(template.settings)}, null)
      on conflict (id) do update
      set name = excluded.name,
          settings = excluded.settings
    `;
    console.log(`essentials: template ${template.name}`);
  }
}

main()
  .catch((error) => {
    console.error("essentials seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
