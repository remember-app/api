import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Language } from "../auth/session.ts";
import { sql } from "../db.ts";

const expoPushUrl = "https://exp.host/--/api/v2/push/send";
const endpoint = () => (process.env.EXPO_PUSH_URL ?? expoPushUrl).trim();
const timeoutMs = 5000;
const expoBatch = 100;
const registerBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: {
    token: { type: "string", minLength: 1, maxLength: 255 },
    platform: { type: "string", enum: ["ios", "android"] },
  },
} as const;
type Message = {
  body: Record<Language, string>;
  data: Record<string, string>;
};
type Recipient = {
  token: string;
  language: Language;
};
async function send(
  log: FastifyBaseLogger,
  kind: "invite" | "montage",
  memoryId: string,
  message: Message,
  tokensOf: () => Promise<Recipient[]>,
): Promise<void> {
  try {
    const url = endpoint();
    const tokens = await tokensOf();
    if (!url || tokens.length === 0) {
      log.info({ message, devices: tokens.length }, `${kind} push not sent`);
      return;
    }
    for (let from = 0; from < tokens.length; from += expoBatch) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          tokens.slice(from, from + expoBatch).map(({ token, language }) => ({
            to: token,
            body: message.body[language],
            data: message.data,
          })),
        ),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        log.warn(
          { status: response.status, body: (await response.text()).slice(0, 500) },
          `${kind} push refused`,
        );
        return;
      }
    }
    log.info({ devices: tokens.length, memoryId }, `${kind} push sent`);
  } catch (error) {
    log.warn({ err: error }, `${kind} push failed`);
  }
}
export async function notifyInvited(
  log: FastifyBaseLogger,
  invitee: string,
  inviter: string | null,
  memory: {
    id: string;
    title: string;
  },
): Promise<void> {
  const who = { ru: inviter ?? "Кто-то", en: inviter ?? "Someone" };
  const message = {
    body: {
      ru: `${who.ru} приглашает вас в «${memory.title}» — загрузите свои фото и видео`,
      en: `${who.en} invites you to “${memory.title}” — add your photos and videos`,
    },
    data: { memoryId: memory.id },
  };
  await send(
    log,
    "invite",
    memory.id,
    message,
    () => sql<Recipient[]>`
      select pt.token, u.language from push_tokens pt
      join users u on u.id = pt.user_id
      where pt.user_id = ${invitee}
    `,
  );
}
export async function notifyMontageReady(
  log: FastifyBaseLogger,
  memory: {
    id: string;
    title: string;
  },
  montageId: string,
): Promise<void> {
  const message = {
    body: {
      ru: `Ролик из «${memory.title}» готов — посмотрите и поделитесь`,
      en: `The movie from “${memory.title}” is ready — take a look and share it`,
    },
    data: { memoryId: memory.id, montageId },
  };
  await send(
    log,
    "montage",
    memory.id,
    message,
    () => sql<Recipient[]>`
      select pt.token, u.language from push_tokens pt
      join memory_members mm on mm.user_id = pt.user_id
      join users u on u.id = pt.user_id
      where mm.memory_id = ${memory.id}
    `,
  );
}
export function pushRoutes(app: FastifyInstance) {
  app.post<{
    Body: {
      token: string;
      platform?: string;
    };
  }>(
    "/me/push-tokens",
    { preHandler: app.authenticate, schema: { body: registerBody } },
    async (request) => {
      const { token, platform } = request.body;
      await sql`
        insert into push_tokens (token, user_id, platform)
        values (${token}, ${request.user.id}, ${platform ?? null})
        on conflict (token) do update
          set user_id = excluded.user_id, platform = excluded.platform
      `;
      return { ok: true };
    },
  );
}
