import { sql } from "../../integrations/db/index.ts";
import type { UserId } from "../../types/id.ts";
import type { UserLimit } from "../../types/limit.ts";

export const limitColumns = sql`user_id as "userId", tokens, storage_bytes as "storageBytes"`;

export async function getLimit(userId: UserId): Promise<UserLimit> {
  const [row] = await sql<UserLimit[]>`
    insert into user_limits (user_id) values (${userId})
    on conflict (user_id) do update set user_id = excluded.user_id
    returning ${limitColumns}
  `;
  if (!row) throw new Error("user_limits upsert returned no row");
  return row;
}
