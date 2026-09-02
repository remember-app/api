import { createHash, randomBytes } from "node:crypto";
import { sql } from "../db.ts";
import { sessionTtlDays } from "./config.ts";

/** What a handler sees behind `app.authenticate`, and the body of `GET /me`. */
export type AuthUser = {
  id: string;
  username: string | null;
  name: string | null;
  email: string | null;
};

/**
 * Only the hash is stored: a dump of the table gets nobody into a session.
 * The token is 32 random bytes, so there is nothing to guess and a bare
 * SHA-256 is enough — no salt, no KDF.
 */
export const hashToken = (token: string) => createHash("sha256").update(token).digest();

/**
 * The session token out of an `Authorization` header, or "" when it carries
 * none. RFC 7235 makes the scheme case-insensitive; clients do send `bearer`.
 * Lives here so that the session check and the routes that need the caller's
 * own token back (logout, "which of these is this device?") read the header
 * the same way.
 */
export const bearerToken = (header = "") =>
  header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

/**
 * Opens a session and returns the raw token — it is not recoverable afterwards.
 *
 * ponytail: nothing collects spent sessions; expired and revoked rows stay.
 * Lookups do not care (they go through the unique token_hash index), so this
 * waits until the row count is worth a sweep.
 */
export async function issue(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`
    insert into sessions (user_id, token_hash, expires_at)
    values (${userId}, ${hashToken(token)}, now() + make_interval(days => ${sessionTtlDays()}))
  `;
  return token;
}

/** A live session yields its user; expired, revoked or unknown yields null. */
export async function verify(token: string): Promise<AuthUser | null> {
  const [user] = await sql<AuthUser[]>`
    select u.id, u.username, u.name, u.email
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${hashToken(token)}
      and s.revoked_at is null
      and s.expires_at > now()
  `;
  return user ?? null;
}

/** Kills one session by id. Says nothing about whose it is — the caller checks. */
export async function revoke(sessionId: string): Promise<void> {
  await sql`update sessions set revoked_at = now() where id = ${sessionId} and revoked_at is null`;
}

/** Kills the session currently in use — this is what signing out is. */
export async function revokeByToken(token: string): Promise<void> {
  await sql`
    update sessions set revoked_at = now()
    where token_hash = ${hashToken(token)} and revoked_at is null
  `;
}
