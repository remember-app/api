/**
 * Every knob is optional, and a value that is not a positive number is a
 * misconfiguration rather than an intent — so it falls back instead of being
 * obeyed. A negative window would otherwise clear the rate-limit counters on
 * every request and switch the limiter off without a word.
 */
export const positive = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  // Floored: the TTLs end up as make_interval arguments, which take integers.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const sessionTtlDays = () => positive("SESSION_TTL_DAYS", 30);
export const emailLoginTtlMinutes = () => positive("EMAIL_LOGIN_TTL_MINUTES", 15);
export const rateWindowMs = () => positive("EMAIL_LOGIN_RATE_WINDOW_MINUTES", 15) * 60_000;

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

export const appleClientId = () => env("APPLE_CLIENT_ID");
export const googleClientId = () => env("GOOGLE_CLIENT_ID");

/**
 * The one switch that lets a sign-in skip the letter, and the whole of that
 * permission: unset, there is no way past the mail provider at all — whatever
 * `NODE_ENV` says, and whether or not the mail keys are there. What it opens
 * is deliberately narrow and is decided in `/auth/email/start` (see
 * src/auth/plugin.ts): with it on, only addresses on test.test — a domain RFC
 * 2606 reserves forever, so it can never be anybody's mail server — and never
 * in production.
 *
 * The only reader here for which presence is not enough. Every other setting
 * fails shut when its value is unreadable; this one *opens*, so an
 * unrecognised value has to leave it closed — `EMAIL_LOGIN_DEV_BYPASS=0` is a
 * person saying no, and presence alone would hear it as yes.
 */
export const devEmailBypass = () =>
  ["1", "true"].includes(env("EMAIL_LOGIN_DEV_BYPASS")?.toLowerCase() ?? "");
