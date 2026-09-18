import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { sql } from "../db.ts";
import { emailLoginMaxAttempts, emailLoginTtlMinutes } from "./config.ts";
import type { AuthUser } from "./session.ts";

/** The address doubles as the `email` provider's account id, so case is folded once, here. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Six digits, which is what a person can hold in their head from a letter to the app. */
const codeDigits = 6;

/**
 * A code with every one of the million equally likely. `randomInt` is the
 * crypto source's own uniform integer — `randomBytes % 1000000` is not, it
 * favours the low end — and the padding is what keeps `000042` a real code
 * rather than a shorter, likelier one.
 */
export const generateCode = () => String(randomInt(10 ** codeDigits)).padStart(codeDigits, "0");

/**
 * The stored form of a code. scrypt and not `hashToken`: that hash is enough
 * for 32 random bytes precisely because there is nothing to guess (see
 * src/auth/session.ts), and here there are a million candidates — a fast hash
 * of one of them is a dump that gets read back in seconds. The salt makes that
 * work per row instead of once for the table; scrypt's defaults (N=16384) cost
 * ~20ms a try, which is nothing once per sign-in and six CPU-hours to a
 * million.
 *
 * The callback form rather than `promisify`: `scrypt`'s overloads make the
 * promisified type unusable, and the wrapper is four lines.
 */
const derive = (code: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(code, salt, 32, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

/**
 * Finds or creates the user behind an address and mints their sign-in code.
 * Returns the raw code; only its salted hash reaches the database.
 *
 * Accounts are never merged on a matching email: the first sighting of a
 * (provider, provider account id) pair creates a user, and only that.
 */
export async function startEmailLogin(email: string): Promise<string> {
  const code = generateCode();
  const salt = randomBytes(16);
  // Derived before the transaction is opened: scrypt is deliberately slow, and
  // the advisory lock below is held against everyone else asking for this same
  // address. There is nothing in the hash that needs the transaction's view.
  const hash = await derive(code, salt);
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
    await tx`delete from email_login_codes where expires_at < now()`;
    // One row per person, so asking again replaces the code instead of adding
    // a second one: five live codes for one address would be five times the
    // guesses standing open against it, and the attempt ceiling would be spent
    // per code rather than per person. The fresh attempts are the price of
    // that — a person who mistyped their way to zero has to ask again, and the
    // rate limit on /auth/email/start is what stops that being unlimited.
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

/**
 * Spends one attempt at the address's live code and, if the code is the right
 * one, extinguishes it and returns its user.
 *
 * Every way of failing — no such address, no live code, expired, wrong digits,
 * attempts already spent — is one `null`, because any difference between them
 * answers a question the caller was not meant to be able to ask.
 */
export async function verifyEmailLoginCode(email: string, code: string): Promise<AuthUser | null> {
  // The attempt is spent in the same statement that reads the row, so a
  // hundred guesses arriving at once are a hundred decrements and not one:
  // reading first and writing after would let them all pass the `> 0` check on
  // the same value. `attempts_left > 0` is where an exhausted code dies — the
  // row is still there, and the right code no longer finds it either.
  const [attempt] = await sql<{ user_id: string; code_salt: Buffer; code_hash: Buffer }[]>`
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
  // No hash is computed when there is no row, and deliberately so. The timing
  // that gives away — slow means «this address has a sign-in in flight» — is
  // not worth a decoy scrypt on an unauthenticated route: anyone can put any
  // address into that state themselves with one /auth/email/start, so the
  // difference tells them nothing they could not arrange, while the decoy
  // would hand them ~20ms of memory-hard work per request with nothing
  // rate-limiting it. As it stands the only way to make this route work is to
  // hold a live code, and minting those is what the limiter on
  // /auth/email/start counts.
  if (!attempt) return null;
  const hash = await derive(code, attempt.code_salt);
  // Both sides are 32 bytes out of scrypt, so the lengths always match and
  // `timingSafeEqual` cannot throw.
  if (!timingSafeEqual(hash, attempt.code_hash)) return null;
  // Extinguished in the statement that reads its user, which is what makes it
  // strictly single-use: of two concurrent attempts with the same right code
  // exactly one takes the row. Keyed on the hash as well as the person, so a
  // code minted in the meantime — a second request while this one was in the
  // air — is not the thing being spent here.
  const [user] = await sql<AuthUser[]>`
    with consumed as (
      delete from email_login_codes
      where user_id = ${attempt.user_id} and code_hash = ${attempt.code_hash}
      returning user_id
    )
    select u.id, u.username, u.name, u.email, u.language
    from users u join consumed c on c.user_id = u.id
  `;
  return user ?? null;
}
