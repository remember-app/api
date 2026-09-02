import { randomBytes } from "node:crypto";
import { sql } from "../db.ts";
import { emailLoginTtlMinutes } from "./config.ts";
import { type AuthUser, hashToken } from "./session.ts";

/** The address doubles as the `email` provider's account id, so case is folded once, here. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** The scheme is already configured in the mobile app. */
export const deepLink = (token: string) =>
  `remember://auth/email?token=${encodeURIComponent(token)}`;

/**
 * Finds or creates the user behind an address and mints a single-use link
 * token. Returns the raw token; only its hash reaches the database.
 *
 * Accounts are never merged on a matching email: the first sighting of a
 * (provider, provider account id) pair creates a user, and only that.
 */
export async function startEmailLogin(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql.begin(async (tx) => {
    // Serializes find-or-create per address: two concurrent requests (a
    // double-tap on the sign-in button) would otherwise race for the
    // auth_identities primary key.
    await tx`select pg_advisory_xact_lock(hashtext(${email}))`;
    const [found] = await tx<{ user_id: string }[]>`
      select user_id from auth_identities
      where provider = 'email' and provider_account_id = ${email}
    `;
    let userId = found?.user_id;
    if (!userId) {
      const [user] = await tx<{ id: string }[]>`
        insert into users (email) values (${email}) returning id
      `;
      if (!user) throw new Error("insert into users returned no row");
      userId = user.id;
      await tx`
        insert into auth_identities (user_id, provider, provider_account_id)
        values (${userId}, 'email', ${email})
      `;
    }
    // ponytail: expiry sweep here instead of a cron — the table lives for
    // minutes and grows only as fast as sign-in requests. Add an index on
    // expires_at and a real collector once those get numerous.
    await tx`delete from email_login_tokens where expires_at < now()`;
    await tx`
      insert into email_login_tokens (token_hash, user_id, expires_at)
      values (
        ${hashToken(token)}, ${userId},
        now() + make_interval(mins => ${emailLoginTtlMinutes()})
      )
    `;
  });
  return token;
}

/**
 * Extinguishes the token and returns its user in one statement, which is what
 * makes it strictly single-use: of two concurrent attempts exactly one takes
 * the row.
 */
export async function consumeEmailLoginToken(token: string): Promise<AuthUser | null> {
  const [user] = await sql<AuthUser[]>`
    with consumed as (
      delete from email_login_tokens
      where token_hash = ${hashToken(token)} and expires_at > now()
      returning user_id
    )
    select u.id, u.username, u.name, u.email
    from users u join consumed c on c.user_id = u.id
  `;
  return user ?? null;
}
