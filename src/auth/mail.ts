import { emailLoginTtlMinutes, env } from "./config.ts";

/**
 * The one letter this product sends: the sign-in link. Resend, over its plain
 * HTTP API — a POST with a Bearer token and a JSON body, which is the whole of
 * the protocol, so there is no SDK here for the same reason `src/media/r2.ts`
 * has no AWS one. (SES was the alternative and was turned down: it wants a
 * SigV4 signature on every call, and out of its sandbox only on request — both
 * are a lot of machinery for a pilot of twenty people.)
 */

/**
 * Where the letter goes. Overridable only so tests can aim it at a host of
 * their own instead of the real API — the same knob, for the same reason, as
 * `EXPO_PUSH_URL` in `src/memories/push.ts`.
 *
 * Through `env` and not `process.env` directly, which is not a tidiness point:
 * `??` alone lets `RESEND_API_URL=` — present and empty, which `.env.example`
 * invites by listing the key — through as `""`, and `fetch("")` throws before
 * a request is made. Every sign-in would then answer 502 with `mailConfigured()`
 * still saying everything is fine. Blank is unset here, as everywhere else.
 */
const resendUrl = "https://api.resend.com/emails";
const endpoint = () => env("RESEND_API_URL") ?? resendUrl;

/** How long a send may hang before the person waiting is told it failed. */
const timeoutMs = 5_000;

/**
 * Nothing is sent until both are set, and a blank value is the same
 * misconfiguration as a missing one — exactly the call `storageConfigured()`
 * makes. Without them the service still boots and `/auth/email/start` says so
 * plainly, rather than answering as though the caller were at fault.
 */
export const mailConfigured = () => Boolean(env("RESEND_API_KEY") && env("MAIL_FROM"));

/**
 * Sends the link, or throws. Throwing is the point: the caller must be able to
 * tell «the letter did not go» from «it went», and neither the provider's
 * status nor its body may reach the person who asked — that text carries our
 * own address and API errors, and the answer must be the same for every
 * address anyway.
 */
export async function sendMagicLink(email: string, link: string): Promise<void> {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env("RESEND_API_KEY")}`,
      "content-type": "application/json",
    },
    // Plain text, no HTML part: the link is a `remember://` deep link, and mail
    // clients that strip unknown schemes out of an <a href> would leave a
    // letter with nothing in it. As text it is at worst copied by hand.
    body: JSON.stringify({
      from: env("MAIL_FROM"),
      to: [email],
      subject: "Вход в Remember",
      text:
        `Откройте эту ссылку на телефоне, чтобы войти:\n\n${link}\n\n` +
        `Ссылка одноразовая и живёт ${emailLoginTtlMinutes()} мин. ` +
        `Если вход запрашивали не вы — просто удалите это письмо.`,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // Read as text, not JSON: an error page or a proxy's answer is not JSON,
    // and this must not throw something else on its way to the log.
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Resend refused the letter: ${response.status} ${body}`);
  }
}
