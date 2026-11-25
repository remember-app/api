import { createHash } from "node:crypto";
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
    const fingerprint = createHash("sha256").update(file).digest("hex");
    const key = systemMediaKey(entry);
    await putObject(key, file, entry.contentType);
    await sql`
      insert into media_items (id, kind, storage_key, fingerprint, format, bytes, meta)
      values (
        ${entry.mediaId},
        'photo',
        ${key},
        ${fingerprint},
        ${entry.format},
        ${file.length},
        ${sql.json({
          dimensions:
            entry.width !== null && entry.height !== null
              ? { width: entry.width, height: entry.height }
              : null,
          duration: null,
          at: null,
          place: null,
          camera: null,
        })}
      )
      on conflict (id) do update
      set kind = excluded.kind,
          storage_key = excluded.storage_key,
          fingerprint = excluded.fingerprint,
          format = excluded.format,
          bytes = excluded.bytes,
          meta = excluded.meta
    `;
    console.log(`essentials: ${entry.name} ${entry.mediaId}`);
  }
}
