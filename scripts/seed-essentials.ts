import { readFileSync } from "node:fs";
import { sql } from "../src/integrations/db/index.ts";
import { putObject, storageConfigured } from "../src/integrations/storage/s3.ts";
import {
  ANALYSIS_PRICE_KEY,
  DEFAULT_ANALYSIS_PRICE,
  DEFAULT_INVITE_REWARDS,
  INVITE_REWARDS_KEY,
} from "../src/services/settings/defaults.ts";
import { SYSTEM_MEDIA, systemMediaKey } from "../src/services/system/media.ts";

async function main(): Promise<void> {
  if (!storageConfigured()) throw new Error("essentials: S3 is not configured");
  for (const entry of SYSTEM_MEDIA) {
    const key = systemMediaKey(entry);
    const file = readFileSync(new URL(`./system-assets/${entry.file}`, import.meta.url));
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
  await sql`
    insert into settings (key, value)
    values (${INVITE_REWARDS_KEY}, ${sql.json(DEFAULT_INVITE_REWARDS)})
    on conflict (key) do nothing
  `;
  console.log(`essentials: setting ${INVITE_REWARDS_KEY}`);
  await sql`
    insert into settings (key, value)
    values (${ANALYSIS_PRICE_KEY}, ${sql.json(DEFAULT_ANALYSIS_PRICE)})
    on conflict (key) do nothing
  `;
  console.log(`essentials: setting ${ANALYSIS_PRICE_KEY}`);
}

main()
  .catch((error) => {
    console.error("essentials seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
