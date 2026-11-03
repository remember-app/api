import { sql } from "../../integrations/db/index.ts";
import type { ProjectId, UserId } from "../../types/id.ts";
import type { PushPlatform, PushToken } from "../../types/push.ts";

const columns = sql`token, user_id as "userId", platform, created_at as "createdAt"`;

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
    returning ${columns}
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

export async function tokensOfUser(userId: UserId): Promise<PushToken[]> {
  return sql<PushToken[]>`select ${columns} from push_tokens where user_id = ${userId}`;
}

export async function tokensOfProject(projectId: ProjectId): Promise<PushToken[]> {
  return sql<PushToken[]>`
    select pt.token, pt.user_id as "userId", pt.platform, pt.created_at as "createdAt"
    from push_tokens pt
    join project_members pm on pm.user_id = pt.user_id
    where pm.project_id = ${projectId}
  `;
}

export async function removeTokens(tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  const rows = await sql`
    delete from push_tokens where token = any(${tokens}) returning token
  `;
  return rows.length;
}
