import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import { downloadUrl } from "../../integrations/storage/s3.ts";
import type { UserId } from "../../types/id.ts";

export async function avatarUrls(ids: UserId[]): Promise<Map<UserId, string | null>> {
  const unique = [...new Set(ids)];
  const urls = new Map<UserId, string | null>();
  if (unique.length === 0) return urls;
  const rows = await sql<{ userId: UserId; storageKey: string }[]>`
    select u.id as "userId", m.storage_key as "storageKey"
    from users u
    join media_items m on m.id = u.profile_media_id
    where u.id = any(${unique})
  `;
  const ttl = config.media.downloadTtlSeconds();
  for (const row of rows) urls.set(row.userId, await downloadUrl(row.storageKey, ttl));
  return urls;
}
