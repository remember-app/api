import { createHash, randomBytes } from "node:crypto";
import { sql } from "../db.ts";
import type { AuthUser, Language } from "../types/user.ts";
import { sessionTtlDays } from "./config.ts";

export type { AuthUser, Language };
export const profileColumns = sql`
  u.id, u.username, u.name, u.email, u.language, u.dates_between_days
`;
export const hashToken = (token: string) => createHash("sha256").update(token).digest();
export const bearerToken = (header = "") =>
  header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
const term = () => sql`make_interval(days => ${sessionTtlDays()})`;
export async function issue(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`
    insert into sessions (user_id, token_hash, expires_at)
    values (${userId}, ${hashToken(token)}, now() + ${term()})
  `;
  return token;
}
export async function verify(token: string): Promise<AuthUser | null> {
  const [user] = await sql<AuthUser[]>`
    with live as (
      select id, user_id
      from sessions
      where token_hash = ${hashToken(token)}
        and revoked_at is null
        and expires_at > now()
    ), renewed as (
      update sessions set expires_at = now() + ${term()}
      where id = (select id from live)
        and expires_at < now() + ${term()} - interval '1 hour'
    )
    select ${profileColumns}
    from live
    join users u on u.id = live.user_id
  `;
  return user ?? null;
}
export async function revoke(sessionId: string): Promise<void> {
  await sql`update sessions set revoked_at = now() where id = ${sessionId} and revoked_at is null`;
}
export async function revokeByToken(token: string): Promise<void> {
  await sql`
    update sessions set revoked_at = now()
    where token_hash = ${hashToken(token)} and revoked_at is null
  `;
}
