import { randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import type { SessionId, UserId } from "../../types/id.ts";
import { codeHash, hashToken, normalizeEmail } from "./internal.ts";

export type FoundUser = {
  userId: UserId;
  registered: boolean;
};

export async function findOrCreateUser(email: string): Promise<FoundUser> {
  const address = normalizeEmail(email);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${address}, 0))`;
    const [identity] = await tx<{ userId: UserId; registered: boolean }[]>`
      select i.user_id as "userId", u.registered
      from auth_identities i
      join users u on u.id = i.user_id
      where i.provider = 'email' and i.provider_account_id = ${address}
    `;
    if (identity) return { userId: identity.userId, registered: identity.registered };
    const username = `u_${randomBytes(8).toString("hex")}`;
    const [user] = await tx<{ id: UserId }[]>`
      insert into users (email, username) values (${address}, ${username}) returning id
    `;
    if (!user) throw new Error("user insert returned no row");
    await tx`
      insert into auth_identities (provider, provider_account_id, user_id)
      values ('email', ${address}, ${user.id})
    `;
    return { userId: user.id, registered: false };
  });
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
