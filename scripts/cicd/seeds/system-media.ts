import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../../src/integrations/db/index.ts";
import { putObject } from "../../../src/integrations/storage/s3.ts";
import { SYSTEM_MEDIA, systemMediaKey } from "../../../src/services/system/media.ts";
import { ASSETS } from "./assets.ts";

const dirOf = (name: string): string => (name.startsWith("onboarding") ? "onboarding" : "images");

export async function seedSystemMedia(): Promise<void> {
  for (const entry of SYSTEM_MEDIA) {
    const file = readFileSync(join(ASSETS, "system", dirOf(entry.name), entry.file));
    const key = systemMediaKey(entry);
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
      set kind = excluded.kind,
          storage_key = excluded.storage_key,
          uploaded_by = excluded.uploaded_by,
          format = excluded.format,
          bytes = excluded.bytes,
          width = excluded.width,
          height = excluded.height
    `;
    console.log(`essentials: ${entry.name} ${entry.mediaId}`);
  }
}
