export const positive = (name: string, fallback: number) => {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const sessionTtlDays = () => positive("SESSION_TTL_DAYS", 365);
export const emailLoginTtlMinutes = () => positive("EMAIL_LOGIN_TTL_MINUTES", 15);
export const rateWindowMs = () => positive("EMAIL_LOGIN_RATE_WINDOW_MINUTES", 15) * 60000;
export const emailLoginMaxAttempts = () => positive("EMAIL_LOGIN_MAX_ATTEMPTS", 5);
export const rateMaxPerEmail = () => positive("EMAIL_LOGIN_RATE_MAX", 5);
export const rateMaxPerIp = () => positive("EMAIL_LOGIN_RATE_MAX_PER_IP", 50);
export const env = (name: string) => process.env[name]?.trim() || undefined;
export const flag = (name: string) => ["1", "true"].includes(env(name)?.toLowerCase() ?? "");
export const devEmailBypass = () => flag("EMAIL_LOGIN_DEV_BYPASS");
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
