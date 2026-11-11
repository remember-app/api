import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../../src/integrations/db/index.ts";
import { putObject } from "../../../src/integrations/storage/s3.ts";
import { ASSETS } from "./assets.ts";

type Track = {
  file: string;
  name: string;
  author: string;
  seconds: number;
};

const suffix = (index: number): string => String(index + 1).padStart(12, "0");

const tracks = (): Track[] =>
  JSON.parse(readFileSync(join(ASSETS, "music", "manifest.json"), "utf8")) as Track[];

export async function seedMusic(): Promise<void> {
  for (const [index, track] of tracks().entries()) {
    const mediaId = `cccccccc-cccc-4ccc-8ccc-${suffix(index)}`;
    const songId = `dddddddd-dddd-4ddd-8ddd-${suffix(index)}`;
    const key = `remember/mp3/${mediaId}`;
    const file = readFileSync(join(ASSETS, "music", track.file));
    await putObject(key, file, "audio/mpeg");
    await sql`
      insert into media_items (
        id, kind, storage_key, uploaded_by, format, bytes, duration
      )
      values (
        ${mediaId}, 'audio', ${key}, null, 'mp3', ${file.length}, ${track.seconds}
      )
      on conflict (id) do update
      set kind = excluded.kind,
          storage_key = excluded.storage_key,
          uploaded_by = excluded.uploaded_by,
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
          media_id = excluded.media_id,
          project_id = excluded.project_id,
          uploaded_by = excluded.uploaded_by
    `;
    console.log(`essentials: track ${track.name}`);
  }
}
