import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../../src/integrations/db/index.ts";
import { putObject } from "../../../src/integrations/storage/s3.ts";
import { SYSTEM_MEDIA } from "../../../src/services/system/media.ts";
import { ASSETS } from "./assets.ts";
import analysisByFile from "./music.analysis.json" with { type: "json" };
import { MUSIC, musicMediaId } from "./music.manifest.ts";

const coverEntry = SYSTEM_MEDIA.find((entry) => entry.name === "song-cover");
if (!coverEntry) throw new Error("seeds: system media has no song-cover");
const COVER_ID = coverEntry.mediaId;

export async function seedMusic(): Promise<void> {
  const songIds: string[] = [];
  const mediaIds: string[] = [];

  for (const [index, track] of MUSIC.entries()) {
    const mediaId = musicMediaId(track.file);
    const songId = `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`;
    songIds.push(songId);
    mediaIds.push(mediaId);
    const key = `remember/mp3/${mediaId}`;
    const file = readFileSync(join(ASSETS, "music", track.file));
    const fingerprint = createHash("sha256").update(file).digest("hex");
    const analysis = (analysisByFile as Record<string, unknown>)[track.file] ?? null;
    await putObject(key, file, "audio/mpeg");
    await sql`
      insert into media_items (id, kind, storage_key, fingerprint, format, bytes, meta)
      values (
        ${mediaId}, 'audio', ${key}, ${fingerprint}, 'mp3', ${file.length},
        ${sql.json({
          dimensions: null,
          duration: track.seconds,
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
    await sql`
      insert into songs (
        id, name, author, original_id, uploaded_by, cover_id, preview_cover_id, analysis
      )
      values (
        ${songId}, ${track.name}, ${track.author}, ${mediaId}, null,
        ${COVER_ID}, ${COVER_ID},
        ${analysis === null ? null : sql.json(analysis as never)}
      )
      on conflict (id) do update
      set name = excluded.name,
          author = excluded.author,
          original_id = excluded.original_id,
          uploaded_by = excluded.uploaded_by,
          cover_id = excluded.cover_id,
          preview_cover_id = excluded.preview_cover_id,
          analysis = excluded.analysis
    `;
    console.log(`essentials: track ${track.name}`);
  }

  await sql`
    delete from songs
    where uploaded_by is null
      and id::text <> all(${songIds})
  `;
  await sql`
    delete from media_items
    where kind = 'audio'
      and id::text <> all(${mediaIds})
      and not exists (select 1 from uploads where uploads.media_id = media_items.id)
  `;
}
