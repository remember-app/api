import { createTransport } from "nodemailer";
import { emailLoginTtlMinutes, env, flag, positive } from "./config.ts";
import type { Language } from "./session.ts";

const timeoutMs = 5000;
export const mailConfigured = () =>
  Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASSWORD") && env("MAIL_FROM"));
type Letter = {
  subject: string;
  text: string;
};
const letter: Record<Language, (code: string, minutes: number) => Letter> = {
  ru: (code, minutes) => ({
    subject: "Вход в Remember",
    text:
      `Введите этот код в приложении, чтобы войти:\n\n${code}\n\n` +
      `Код одноразовый и живёт ${minutes} мин. ` +
      `Если вход запрашивали не вы — просто удалите это письмо.`,
  }),
  en: (code, minutes) => ({
    subject: "Your sign-in code for Remember",
    text:
      `Here is the code that signs you in — type it into the app:\n\n${code}\n\n` +
      `It works once, and only within a ${minutes}-minute window. ` +
      `If you did not ask to sign in, ignore this email and the code expires on its own.`,
  }),
};
export async function sendLoginCode(
  email: string,
  code: string,
  language: Language = "ru",
): Promise<void> {
  const { subject, text } = letter[language](code, emailLoginTtlMinutes());
  const secure = flag("SMTP_SECURE");
  const port = positive("SMTP_PORT", secure ? 465 : 587);
  const transport = createTransport({
    host: env("SMTP_HOST"),
    port,
    secure: secure || port === 465,
    requireTLS: true,
    auth: { user: env("SMTP_USER"), pass: env("SMTP_PASSWORD") },
    dnsTimeout: timeoutMs,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  await transport.sendMail({ from: env("MAIL_FROM"), to: email, subject, text });
}
