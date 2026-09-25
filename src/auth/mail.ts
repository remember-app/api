import { createTransport } from "nodemailer";
import { emailLoginTtlMinutes, env, flag, positive } from "./config.ts";
import type { Language } from "./session.ts";

/**
 * The one letter this product sends: the sign-in code, over plain SMTP to
 * whatever mailbox the environment names. nodemailer and not a client of our
 * own: STARTTLS and AUTH are a conversation, not one request, and it speaks
 * them with no dependencies of its own.
 */

/**
 * How long the mail server may stay silent — resolving, connecting, greeting,
 * or mid-conversation — before the person waiting is told it failed.
 */
const timeoutMs = 5_000;

/**
 * Nothing is sent until all four are set, and a blank value is the same
 * misconfiguration as a missing one — exactly the call `storageConfigured()`
 * makes. The port and the kind of encryption have defaults; these do not.
 * Without them the service still boots and `/auth/email/start` says so
 * plainly, rather than answering as though the caller were at fault.
 */
export const mailConfigured = () =>
  Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASSWORD") && env("MAIL_FROM"));

type Letter = { subject: string; text: string };

/**
 * The letter, in each language, written by hand — the English one is not a
 * rendering of the Russian one but its own letter, said the way English says
 * it. A machine translation of the Russian reads like a machine, and this is
 * the first thing anyone sees of the product.
 *
 * The minute count is spelled as «a 15-minute window» in English on purpose:
 * an attributive number stays singular whatever the TTL is set to, so no
 * plural rule has to exist here.
 */
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

/**
 * Sends the code, or throws. Throwing is the point: the caller must be able to
 * tell «the letter did not go» from «it went», and none of the mail server's
 * own words may reach the person who asked — they carry our own mailbox and
 * its errors, and the answer must be the same for every address anyway.
 *
 * The language comes from whoever asked for the code and nowhere else: this is
 * pre-authentication, so there is no session and, for an address seen for the
 * first time, no user row to hold a preference either. Russian by default —
 * that is what every caller got before the field existed.
 *
 * The transport is made per letter, not once: the settings are read when the
 * letter goes, like every other setting here, and a transport that is not
 * pooled opens a connection per letter anyway.
 */
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
    // 465 is encrypted from the first byte whatever SMTP_SECURE says: spoken to
    // in the clear it never greets, and every letter dies on a bare timeout.
    secure: secure || port === 465,
    // Encrypted or not sent: on 587 the upgrade is the server's offer, and a
    // server that does not make it — or somebody in the middle striking it
    // out — would otherwise get the password in the clear.
    requireTLS: true,
    auth: { user: env("SMTP_USER"), pass: env("SMTP_PASSWORD") },
    dnsTimeout: timeoutMs,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  // Plain text, no HTML part: the whole letter is six digits and a sentence
  // around them, and an HTML twin would be a second copy of that text to keep
  // in step for no gain. It also reads the same everywhere, which matters for
  // the one line anybody actually copies out of it.
  await transport.sendMail({ from: env("MAIL_FROM"), to: email, subject, text });
}
