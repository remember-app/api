import { sql } from "../../src/integrations/db/index.ts";
import { enqueue, liveJobId } from "../../src/services/queue/commands.ts";
import type { MediaId } from "../../src/types/id.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Track = { name: string; mediaId: MediaId };

async function queue(track: Track): Promise<boolean> {
  const live = await liveJobId("media_analysis", track.mediaId);
  if (live !== undefined) {
    console.log(`skip ${track.name}: analysis already queued as job ${live}`);
    return false;
  }
  const job = await enqueue("media_analysis", track.mediaId);
  console.log(`queued ${track.name}: job ${job}`);
  return true;
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) throw new Error("usage: analyze-song <song-id> | --all");

  if (id === "--all") {
    const tracks = await sql<Track[]>`
      select distinct on (media_id) name, media_id as "mediaId"
      from songs
      order by media_id, name
    `;
    let queued = 0;
    for (const track of tracks) if (await queue(track)) queued += 1;
    console.log(`songs: ${tracks.length}, queued: ${queued}`);
    return;
  }

  if (!uuid.test(id)) throw new Error(`not a song id: ${id}`);
  const [track] = await sql<Track[]>`
    select name, media_id as "mediaId" from songs where id = ${id}
  `;
  if (!track) throw new Error(`song ${id} not found`);
  await queue(track);
}

main()
  .catch((error) => {
    console.error("analyze-song failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
