import { sql } from "../../integrations/db/index.ts";
import type { UserId } from "../../types/id.ts";
import type { PushPlatform, PushToken } from "../../types/push.ts";
import { tokenColumns } from "./internal.ts";

export async function registerToken(
  userId: UserId,
  token: string,
  platform: PushPlatform,
): Promise<PushToken> {
  const [row] = await sql<PushToken[]>`
    insert into push_tokens (token, user_id, platform)
    values (${token}, ${userId}, ${platform})
    on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform
    returning ${tokenColumns}
  `;
  if (!row) throw new Error("push token insert returned no row");
  return row;
}

export async function removeToken(userId: UserId, token: string): Promise<boolean> {
  const rows = await sql`
    delete from push_tokens where token = ${token} and user_id = ${userId} returning token
  `;
  return rows.length > 0;
}

export async function removeTokens(tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  const rows = await sql`
    delete from push_tokens where token = any(${tokens}) returning token
  `;
  return rows.length;
}
