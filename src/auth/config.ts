/**
 * Every knob is optional, and every one of them counts something whole — days,
 * minutes, tries. A value that is not a positive whole number is a
 * misconfiguration rather than an intent, so it falls back instead of being
 * obeyed. A negative window would otherwise clear the rate-limit counters on
 * every request and switch the limiter off without a word.
 */
export const positive = (name: string, fallback: number) => {
  // Floored *before* the test and not after: the TTLs end up as make_interval
  // arguments, which take integers, and a fraction is a positive number that
  // floors to nothing. `EMAIL_LOGIN_RATE_WINDOW_MINUTES=0.5` used to mean a
  // window of 0 ms — the counters cleared on every request and the limiter was
  // off, exactly the hole the negative value above leaves — and
  // `EMAIL_LOGIN_TTL_MINUTES=0.5` a code expired before the letter went out.
  // Half a minute is a thing a person types, so it falls back like a negative.
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const sessionTtlDays = () => positive("SESSION_TTL_DAYS", 30);
export const emailLoginTtlMinutes = () => positive("EMAIL_LOGIN_TTL_MINUTES", 15);
export const rateWindowMs = () => positive("EMAIL_LOGIN_RATE_WINDOW_MINUTES", 15) * 60_000;

/**
 * How many times a sign-in code may be got wrong before it is dead — to the
 * right digits as much as to the wrong ones, so the only way on is to ask for
 * a new one.
 *
 * The count is per code and not per address, and that is the pairing that makes
 * a six-digit secret defensible at all: the code is one of a million, so what
 * bounds a guesser is this ceiling multiplied by `rateMaxPerEmail` — five tries
 * at each of five codes a window, twenty-five of a million, which is a
 * one-in-forty-thousand window rather than a script left running overnight.
 * Raising either knob raises that product, so they are read together or not at
 * all.
 */
export const emailLoginMaxAttempts = () => positive("EMAIL_LOGIN_MAX_ATTEMPTS", 5);

/** Per address: the anti-enumeration ceiling, tight because one person needs few. */
export const rateMaxPerEmail = () => positive("EMAIL_LOGIN_RATE_MAX", 5);

/**
 * Per IP: a coarse abuse backstop, deliberately far looser. Phones share
 * carrier NAT and offices share one address, so a tight IP ceiling locks out
 * real people who merely signed in after somebody else.
 */
export const rateMaxPerIp = () => positive("EMAIL_LOGIN_RATE_MAX_PER_IP", 50);

/**
 * A setting that has no fallback and cannot have one: blank is the same
 * misconfiguration as absent, and both mean «not set». Shared for the reason
 * `positive` is (see `src/media/config.ts`) — it is one rule and there is one
 * of it, so a caller cannot half-remember it. Obeying an empty string is the
 * failure mode it exists to prevent: an unchecked `aud` accepts a token Apple
 * minted for somebody else's app, and an empty endpoint is a URL that parses
 * as nothing.
 */
export const env = (name: string) => process.env[name]?.trim() || undefined;

/** An on/off switch: `1` or `true`, in any case, is on; anything else — absence included — is off. */
export const flag = (name: string) => ["1", "true"].includes(env(name)?.toLowerCase() ?? "");

export const appleClientId = () => env("APPLE_CLIENT_ID");
export const googleClientId = () => env("GOOGLE_CLIENT_ID");

/**
 * The switch that lets a development sign-in skip the letter, and the whole of
 * that permission: unset, there is no development way past the mail provider
 * at all — whatever `NODE_ENV` says, and whether or not the mail keys are
 * there. What it opens is deliberately narrow and is decided in
 * `/auth/email/start` (see src/auth/plugin.ts): with it on, only addresses on
 * test.test — a domain RFC 2606 reserves forever, so it can never be anybody's
 * mail server — and never in production. The one other way past the letter is
 * `reviewLogin` below, and it is not this lock's business.
 *
 * The only reader here for which presence is not enough. Every other setting
 * fails shut when its value is unreadable; this one *opens*, so an
 * unrecognised value has to leave it closed — `EMAIL_LOGIN_DEV_BYPASS=0` is a
 * person saying no, and presence alone would hear it as yes.
 */
export const devEmailBypass = () => flag("EMAIL_LOGIN_DEV_BYPASS");

/**
 * The review door: one address that signs in on a fixed code instead of a
 * letter, production included. Apple's reviewer of the TestFlight build needs
 * a working sign-in and cannot read our mail — a deliberate exception to «no
 * way past the mail in production», and a narrow one: one address, and
 * nothing else about the sign-in differs (see `/auth/email/start`).
 *
 * `address:code`, read once when the app is built. Blank is absent and means
 * no door, as for every setting here; anything else that is not a lowercase
 * address and six digits throws, so a half-set or mistyped value stops the
 * server instead of quietly leaving the reviewer locked out. Lowercase because
 * that is the form the account is filed under (`normalizeEmail`), so the one
 * spelling the door opens for is the account's own. The message names the
 * setting and never its value: the value is a key to an account.
 */
export function reviewLogin() {
  const value = env("REVIEW_LOGIN");
  if (!value) return undefined;
  const [, email, code] = /^([^\s@:]+@[^\s@:]+):(\d{6})$/.exec(value) ?? [];
  if (!email || !code || email !== email.toLowerCase()) {
    throw new Error(
      "REVIEW_LOGIN is not a lowercase address, a colon and six digits — see docs/auth.md",
    );
  }
  return { email, code };
}
