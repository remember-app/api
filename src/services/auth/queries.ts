import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { AuthSession } from "../../types/auth.ts";
import type { UserId } from "../../types/id.ts";
import { hashToken, normalizeEmail, sessionColumns } from "./internal.ts";

export async function findUserByEmail(email: string): Promise<UserId | undefined> {
  const address = normalizeEmail(email);
  const [row] = await sql<{ userId: UserId }[]>`
    select user_id as "userId"
    from auth_identities
    where provider = 'email' and provider_account_id = ${address}
  `;
  return row?.userId;
}

export async function verifySession(token: string): Promise<AuthSession | undefined> {
  const [row] = await sql<AuthSession[]>`
    select ${sessionColumns}
    from auth_sessions
    where token_hash = ${hashToken(token)}
      and revoked_at is null
      and expires_at > now()
  `;
  return row;
}

export async function listSessions(
  userId: UserId,
  limit: number,
  offset: number,
): Promise<Page<AuthSession>> {
  const rows = await sql<AuthSession[]>`
    select ${sessionColumns}
    from auth_sessions
    where user_id = ${userId} and revoked_at is null and expires_at > now()
    order by created_at desc
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}
