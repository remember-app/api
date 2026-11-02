import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { sql } from "../db.ts";
import { emailLoginMaxAttempts, emailLoginTtlMinutes } from "./config.ts";
import { type AuthUser, profileColumns } from "./session.ts";
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const codeDigits = 6;
export const generateCode = () => String(randomInt(10 ** codeDigits)).padStart(codeDigits, "0");
const derive = (code: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(code, salt, 32, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
export async function startEmailLogin(email: string, code = generateCode()): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(code, salt);
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${email}))`;
    const [found] = await tx<
      {
        user_id: string;
      }[]
    >`
      select user_id from auth_identities
      where provider = 'email' and provider_account_id = ${email}
    `;
    let userId = found?.user_id;
    if (!userId) {
      const [user] = await tx<
        {
          id: string;
        }[]
      >`
        insert into users (email) values (${email}) returning id
      `;
      if (!user) throw new Error("insert into users returned no row");
      userId = user.id;
      await tx`
        insert into auth_identities (user_id, provider, provider_account_id)
        values (${userId}, 'email', ${email})
      `;
    }
    await tx`delete from email_login_codes where expires_at < now()`;
    await tx`
      insert into email_login_codes (user_id, code_salt, code_hash, expires_at, attempts_left)
      values (
        ${userId}, ${salt}, ${hash},
        now() + make_interval(mins => ${emailLoginTtlMinutes()}),
        ${emailLoginMaxAttempts()}
      )
      on conflict (user_id) do update set
        code_salt = excluded.code_salt,
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts_left = excluded.attempts_left,
        created_at = now()
    `;
  });
  return code;
}
export async function verifyEmailLoginCode(email: string, code: string): Promise<AuthUser | null> {
  const [attempt] = await sql<
    {
      user_id: string;
      code_salt: Buffer;
      code_hash: Buffer;
    }[]
  >`
    update email_login_codes c
    set attempts_left = attempts_left - 1
    where c.user_id = (
      select user_id from auth_identities
      where provider = 'email' and provider_account_id = ${email}
    )
      and c.expires_at > now()
      and c.attempts_left > 0
    returning c.user_id, c.code_salt, c.code_hash
  `;
  if (!attempt) return null;
  const hash = await derive(code, attempt.code_salt);
  if (!timingSafeEqual(hash, attempt.code_hash)) return null;
  const [user] = await sql<AuthUser[]>`
    with consumed as (
      delete from email_login_codes
      where user_id = ${attempt.user_id} and code_hash = ${attempt.code_hash}
      returning user_id
    )
    select ${profileColumns}
    from users u join consumed c on c.user_id = u.id
  `;
  return user ?? null;
}
