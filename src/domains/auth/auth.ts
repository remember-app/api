import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { AuthSession } from "../../types/auth.ts";
import type { SessionId, UserId } from "../../types/id.ts";

const scrypt = promisify(scryptCallback);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const hashToken = (token: string) => createHash("sha256").update(token).digest();

const codeHash = (code: string, salt: Buffer) => scrypt(code, salt, 32) as Promise<Buffer>;

export async function findOrCreateUser(email: string): Promise<UserId> {
  const address = normalizeEmail(email);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${address}, 0))`;
    const [identity] = await tx<{ userId: UserId }[]>`
      select user_id as "userId"
      from auth_identities
      where provider = 'email' and provider_account_id = ${address}
    `;
    if (identity) return identity.userId;
    const [user] = await tx<{ id: UserId }[]>`
      insert into users (email) values (${address}) returning id
    `;
    if (!user) throw new Error("user insert returned no row");
    await tx`
      insert into auth_identities (provider, provider_account_id, user_id)
      values ('email', ${address}, ${user.id})
    `;
    return user.id;
  });
}

export async function findUserByEmail(email: string): Promise<UserId | undefined> {
  const address = normalizeEmail(email);
  const [row] = await sql<{ userId: UserId }[]>`
    select user_id as "userId"
    from auth_identities
    where provider = 'email' and provider_account_id = ${address}
  `;
  return row?.userId;
}

export async function setLoginCode(
  userId: UserId,
  code: string,
  ttlMinutes: number,
): Promise<void> {
  const salt = randomBytes(16);
  const hash = await codeHash(code, salt);
  await sql`
    insert into auth_login_codes (user_id, code_hash, code_salt, expires_at, attempts_left)
    values (
      ${userId},
      ${hash},
      ${salt},
      now() + make_interval(mins => ${ttlMinutes}),
      ${config.auth.emailLoginMaxAttempts()}
    )
    on conflict (user_id) do update
    set code_hash = excluded.code_hash,
        code_salt = excluded.code_salt,
        created_at = now(),
        expires_at = excluded.expires_at,
        attempts_left = excluded.attempts_left
  `;
}

type CodeRow = {
  codeHash: Buffer;
  codeSalt: Buffer;
  expiresAt: Date;
  attemptsLeft: number;
};

export async function verifyLoginCode(userId: UserId, code: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx<CodeRow[]>`
      select
        code_hash as "codeHash",
        code_salt as "codeSalt",
        expires_at as "expiresAt",
        attempts_left as "attemptsLeft"
      from auth_login_codes
      where user_id = ${userId}
      for update
    `;
    if (!row || row.attemptsLeft <= 0 || row.expiresAt <= new Date()) return false;
    const expected = await codeHash(code, row.codeSalt);
    const matches =
      expected.length === row.codeHash.length && timingSafeEqual(expected, row.codeHash);
    if (matches) {
      await tx`delete from auth_login_codes where user_id = ${userId}`;
      return true;
    }
    const [left] = await tx<{ attemptsLeft: number }[]>`
      update auth_login_codes
      set attempts_left = attempts_left - 1
      where user_id = ${userId}
      returning attempts_left as "attemptsLeft"
    `;
    if (left && left.attemptsLeft <= 0) {
      await tx`delete from auth_login_codes where user_id = ${userId}`;
    }
    return false;
  });
}

export async function issueSession(userId: UserId): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`
    insert into auth_sessions (user_id, token_hash, expires_at)
    values (
      ${userId},
      ${hashToken(token)},
      now() + make_interval(days => ${config.auth.sessionTtlDays()})
    )
  `;
  return token;
}

export const sessionColumns = sql`
  id,
  user_id as "userId",
  created_at as "createdAt",
  expires_at as "expiresAt",
  revoked_at as "revokedAt"
`;

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

export async function revokeSession(id: SessionId, userId: UserId): Promise<boolean> {
  const rows = await sql`
    update auth_sessions
    set revoked_at = now()
    where id = ${id} and user_id = ${userId} and revoked_at is null
    returning id
  `;
  return rows.length > 0;
}

export async function revokeSessionByToken(token: string): Promise<boolean> {
  const rows = await sql`
    update auth_sessions
    set revoked_at = now()
    where token_hash = ${hashToken(token)} and revoked_at is null
    returning id
  `;
  return rows.length > 0;
}
