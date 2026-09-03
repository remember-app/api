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
 * Our client id at a social provider — the `aud` an id token must carry. There
 * is no fallback here and cannot be: a blank value is the same misconfiguration
 * as an absent one, and both mean the provider stays off. Obeying an empty
 * string would leave `aud` unchecked, which is to say it would accept a token
 * Apple minted for somebody else's app.
 */
const clientId = (name: string) => process.env[name]?.trim() || undefined;

export const appleClientId = () => clientId("APPLE_CLIENT_ID");
export const googleClientId = () => clientId("GOOGLE_CLIENT_ID");
