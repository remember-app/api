import { fileURLToPath } from "node:url";
import { createTransport } from "nodemailer";
import { config } from "../../config.ts";
import { type Language, loginCodeLetter } from "./letters/login-code.ts";

const logoPath = fileURLToPath(new URL("../../../assets/mail/logo.png", import.meta.url));

export const mailConfigured = () => config.smtp.configured();

export async function sendLoginCode(
  email: string,
  code: string,
  language: Language = "ru",
): Promise<void> {
  const { subject, text, html } = loginCodeLetter[language](
    code,
    config.auth.emailLoginTtlMinutes(),
  );
  const transport = createTransport({
    host: config.smtp.host(),
    port: config.smtp.port(),
    secure: config.smtp.secure() || config.smtp.port() === 465,
    requireTLS: true,
    auth: { user: config.smtp.user(), pass: config.smtp.password() },
    dnsTimeout: config.smtp.timeoutMs,
    connectionTimeout: config.smtp.timeoutMs,
    greetingTimeout: config.smtp.timeoutMs,
    socketTimeout: config.smtp.timeoutMs,
  });
  await transport.sendMail({
    from: config.smtp.from(),
    to: email,
    subject,
    text,
    html,
    attachments: [{ filename: "remember-logo.png", path: logoPath, cid: "remember-logo" }],
  });
}
