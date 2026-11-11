import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../../src/integrations/db/index.ts";
import { putObject } from "../../../src/integrations/storage/s3.ts";
import { ASSETS } from "./assets.ts";
import { MUSIC } from "./music.manifest.ts";

const suffix = (index: number): string => String(index + 1).padStart(12, "0");

export async function seedMusic(): Promise<void> {
  const songIds: string[] = [];
  const mediaIds: string[] = [];

  for (const [index, track] of MUSIC.entries()) {
    const mediaId = `cccccccc-cccc-4ccc-8ccc-${suffix(index)}`;
    const songId = `dddddddd-dddd-4ddd-8ddd-${suffix(index)}`;
    songIds.push(songId);
    mediaIds.push(mediaId);
    const key = `remember/mp3/${mediaId}`;
    const file = readFileSync(join(ASSETS, "music", track.file));
    const fingerprint = createHash("sha256").update(file).digest("hex");
    await putObject(key, file, "audio/mpeg");
    await sql`
      insert into media_items (
        id, kind, storage_key, fingerprint, uploaded_by, format, bytes, duration
      )
      values (
        ${mediaId}, 'audio', ${key}, ${fingerprint}, null, 'mp3', ${file.length}, ${track.seconds}
      )
      on conflict (id) do update
      set kind = excluded.kind,
          storage_key = excluded.storage_key,
          fingerprint = excluded.fingerprint,
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

  await sql`
    delete from songs
    where project_id is null
      and uploaded_by is null
      and id::text <> all(${songIds})
  `;
  await sql`
    delete from media_items
    where uploaded_by is null
      and kind = 'audio'
      and id::text <> all(${mediaIds})
  `;
}
