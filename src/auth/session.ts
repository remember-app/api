import { createHash, randomBytes } from "node:crypto";
import { sql } from "../db.ts";
import { sessionTtlDays } from "./config.ts";

/**
 * The two languages the product speaks (doc-8), as the BCP 47 subtags the
 * phone reports. Kept beside `AuthUser` because it is a property of the person:
 * what is composed for them — a push, a letter — is written in it, and that
 * happens where their request is not.
 */
export type Language = "ru" | "en";

/** What a handler sees behind `app.authenticate`, and the body of `GET /me`. */
export type AuthUser = {
  id: string;
  username: string | null;
  name: string | null;
  email: string | null;
  language: Language;
  /** «Даты между днями» in the frame feed — one switch for the whole account, not per memory. */
  dates_between_days: boolean;
};

/**
 * The columns of `AuthUser`, read off `users` under the alias `u`. Every
 * statement that hands a profile back selects exactly this, so the profile a
 * sign-in answers with, the one `GET /me` shows and the one a `/me/*` change
 * returns cannot drift apart: a field is added here and to the type above,
 * nowhere else.
 */
export const profileColumns = sql`
  u.id, u.username, u.name, u.email, u.language, u.dates_between_days
`;

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

/** How long a session lives from its last use: the one term issuing and renewal share. */
const term = () => sql`make_interval(days => ${sessionTtlDays()})`;

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
    values (${userId}, ${hashToken(token)}, now() + ${term()})
  `;
  return token;
}

/**
 * A live session yields its user; expired, revoked or unknown yields null.
 *
 * Using a session keeps it alive: its term starts over from the moment of use,
 * so it dies only of a whole term untouched, or of being revoked. The restart
 * is written at most once an hour, not on every call — this runs on nearly
 * every request, parallel chunk uploads included, and each write is a row
 * version and a row lock. The price is that a session may expire up to an hour
 * short of a full term after its last use. Not «once half the term is left»:
 * then half a term of disuse could already cost a sign-in by letter.
 *
 * The renewal writes `expires_at` alone, so it cannot undo a revocation, and
 * reaches only a session found live, so it cannot raise an expired one.
 */
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
