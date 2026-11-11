import { pathToFileURL } from "node:url";
import { sql } from "../../../src/integrations/db/index.ts";
import { storageConfigured } from "../../../src/integrations/storage/s3.ts";
import { seedMontageTemplates } from "./montage-templates.ts";
import { seedMusic } from "./music.ts";
import { seedSettings } from "./settings.ts";
import { seedSystemMedia } from "./system-media.ts";

export async function seed(): Promise<void> {
  if (!storageConfigured()) throw new Error("seeds: S3 is not configured");
  await seedSystemMedia();
  await seedMusic();
  await seedSettings();
  await seedMontageTemplates();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .catch((error) => {
      console.error("seeds failed:", error);
      process.exitCode = 1;
    })
    .finally(() => sql.end());
}
