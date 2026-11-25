import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Language = "ru" | "en";

export type Letter = {
  subject: string;
  text: string;
  html: string;
};

const logo = readFileSync(
  fileURLToPath(new URL("../../../../assets/mail/logo.svg", import.meta.url)),
  "utf8",
)
  .replace(
    'width="2048" height="2048"',
    'width="64" height="64" style="display:block;margin:0 auto 14px;"',
  )
  .replace('fill="#f5f3ee"', 'class="logo-ink"')
  .replace('fill="#4b5bff"', 'class="logo-blue"')
  .replace('fill="#e4ff4f"', 'class="logo-spark"');

type Copy = {
  subject: string;
  preheader: string;
  title: string;
  hint: string;
  expiry: (minutes: number) => string;
  ignore: string;
  text: (code: string, minutes: number) => string;
};

const minutesWord = (minutes: number): string => {
  const last = minutes % 10;
  const pair = minutes % 100;
  if (last === 1 && pair !== 11) return "минуту";
  if (last >= 2 && last <= 4 && (pair < 12 || pair > 14)) return "минуты";
  return "минут";
};

const ru: Copy = {
  subject: "Вход в Remember",
  preheader: "Откройте приложение и введите код, чтобы войти.",
  title: "Код для входа",
  hint: "Откройте приложение и введите эти шесть цифр.",
  expiry: (minutes) => `Код одноразовый и действует ${minutes} ${minutesWord(minutes)}.`,
  ignore: "Если вход запрашивали не вы — проигнорируйте это письмо.",
  text: (code, minutes) =>
    `Введите этот код в приложении, чтобы войти:\n\n${code}\n\n` +
    `Код одноразовый и живёт ${minutes} мин. ` +
    `Если вход запрашивали не вы — просто удалите это письмо.`,
};

const en: Copy = {
  subject: "Your sign-in code for Remember",
  preheader: "Type this code in the app to sign in.",
  title: "Your sign-in code",
  hint: "Open the app and enter these six digits.",
  expiry: (minutes) => `This code works once and expires in ${minutes} minutes.`,
  ignore: "If you did not ask to sign in, just ignore this email.",
  text: (code, minutes) =>
    `Here is the code that signs you in — type it into the app:\n\n${code}\n\n` +
    `It works once, and only within a ${minutes}-minute window. ` +
    `If you did not ask to sign in, ignore this email and the code expires on its own.`,
};

const cell =
  'class="code-cell" width="52" height="66" align="center" valign="middle" ' +
  'style="width:52px;height:66px;border:1px solid #C4BCA8;border-radius:10px;background:#F7F4EC;' +
  'font-size:30px;line-height:66px;font-weight:700;color:#15151C;font-variant-numeric:tabular-nums;"';
const gap = 'class="code-gap" width="8" style="width:8px;font-size:0;line-height:0;"';

const digits = (code: string): string =>
  code
    .split("")
    .map((digit, index) => `${index ? `<td ${gap}>&nbsp;</td>` : ""}<td ${cell}>${digit}</td>`)
    .join("");

const layout = (copy: Copy, lang: Language, code: string, minutes: number): string =>
  `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${copy.subject}</title>
<style>
.logo-ink { fill:#15151C; }
.logo-blue { fill:#3B3FE0; }
.logo-spark { fill:#DCF531; }
@media only screen and (prefers-color-scheme: dark) {
  body, .mail-bg { background:#0B0B12 !important; }
  .card { background:#16161F !important; border-color:#2C2C3A !important; }
  .logo-ink { fill:#F5F3EE !important; }
  .logo-blue { fill:#4B5BFF !important; }
  .logo-spark { fill:#E4FF4F !important; }
  .accent { background:#4B5BFF !important; }
  .ink { color:#F5F3EE !important; }
  .subtle { color:#D8D5E0 !important; }
  .muted { color:#A4A1B2 !important; }
  .code-cell { background:#1A1A24 !important; border-color:#45424F !important; color:#F5F3EE !important; }
  .divider { background:#2C2C3A !important; }
  .preheader { color:#0B0B12 !important; }
}
@media only screen and (max-width: 440px) {
  .card-body { padding: 32px 16px 24px !important; }
  .code-cell { width: 44px !important; height: 56px !important; line-height: 56px !important; font-size: 26px !important; }
  .code-gap { width: 5px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#ECE8DE;">
<div class="preheader" style="display:none;max-height:0;overflow:hidden;opacity:0;color:#ECE8DE;font-size:1px;line-height:1px;">${copy.preheader}</div>
<table class="mail-bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ECE8DE;padding:32px 12px;">
  <tr><td align="center">
    <table class="card" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;border-collapse:separate;border:1px solid #E4DFD3;border-radius:18px;background:#FFFFFF;">
      <tr><td class="card-body" align="center" style="padding:40px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Onest,Arial,sans-serif;">
        ${logo}
        <div class="ink" style="font-size:20px;line-height:24px;font-weight:600;letter-spacing:.4px;color:#15151C;">Remember</div>
        <div class="accent" style="width:44px;height:3px;margin:20px auto 26px;border-radius:2px;background:#3B3FE0;font-size:0;line-height:0;">&nbsp;</div>
        <div class="ink" style="font-size:25px;line-height:30px;font-weight:700;letter-spacing:-.7px;color:#15151C;">${copy.title}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto 22px;border-collapse:separate;"><tr>${digits(code)}</tr></table>
        <p class="subtle" style="margin:0;font-size:15px;line-height:22px;color:#15151C;">${copy.hint}</p>
        <div class="divider" style="height:1px;margin:28px 0 20px;background:#E4DFD3;font-size:0;line-height:0;">&nbsp;</div>
        <p class="muted" style="margin:0 0 8px;font-size:13px;line-height:19px;color:#6C6979;">${copy.expiry(minutes)}</p>
        <p class="muted" style="margin:0;font-size:13px;line-height:19px;color:#6C6979;">${copy.ignore}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

const letter =
  (lang: Language, copy: Copy) =>
  (code: string, minutes: number): Letter => ({
    subject: copy.subject,
    text: copy.text(code, minutes),
    html: layout(copy, lang, code, minutes),
  });

export const loginCodeLetter: Record<Language, (code: string, minutes: number) => Letter> = {
  ru: letter("ru", ru),
  en: letter("en", en),
};
