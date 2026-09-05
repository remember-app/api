import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { sql } from "../db.ts";

/**
 * Where Expo takes a notification. Overridable only so tests can aim it at a
 * host that is not there; set it empty to switch pushing off entirely, which
 * is what a machine with no way out to the internet wants.
 */
const expoPushUrl = "https://exp.host/--/api/v2/push/send";
const endpoint = () => (process.env.EXPO_PUSH_URL ?? expoPushUrl).trim();

/** How long a send may hang before it is somebody else's problem. */
const timeoutMs = 5_000;

const registerBody = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: {
    // Expo's own token («ExponentPushToken[…]») — not parsed here: its shape
    // is Expo's to change, and a token they reject costs one logged line.
    token: { type: "string", minLength: 1, maxLength: 255 },
    // The only two clients there are. Optional: it is a convenience for
    // reading the table, nothing branches on it.
    platform: { type: "string", enum: ["ios", "android"] },
  },
} as const;

/** What Expo is handed: the line on the lock screen and what the app opens on. */
type Message = { body: string; data: Record<string, string> };

/**
 * The one way a notification leaves this service. Never throws — every failure
 * (no tokens, pushing off, Expo down, Expo cross, the database refusing the
 * token query) leaves a line in the log and nothing else, because both callers
 * notify **after** committing what they notify about: the person is a member,
 * and the video is assembled, whether or not this lands.
 *
 * `kind` is the first word of every line it writes, so «who failed to send» is
 * readable in the log without the sender's own wording.
 *
 * The tokens come as a thunk rather than as a list: reading them is part of
 * what must not throw, and the two callers read different rows — one person's
 * devices for an invite, a whole memory's for a finished video.
 *
 * ponytail: one shot, no retry. A notification lost to a network blip is lost
 * for good — the thing it announces is still there, so the cost is that the
 * person finds it on their own next time they open the app. If they start
 * getting lost often enough to notice, this moves onto the `jobs` queue
 * (architecture.md, «Очередь задач»), which already retries with backoff.
 */
async function send(
  log: FastifyBaseLogger,
  kind: "invite" | "montage",
  memoryId: string,
  message: Message,
  tokensOf: () => Promise<{ token: string }[]>,
): Promise<void> {
  try {
    const url = endpoint();
    const tokens = await tokensOf();
    // Nobody to tell, or nowhere to tell it: still worth a line, because this
    // is the whole of what a developer sees on a machine without push.
    if (!url || tokens.length === 0) {
      log.info({ message, devices: tokens.length }, `${kind} push not sent`);
      return;
    }
    // One request for every device: Expo takes an array, and the failure of one
    // device is not worth a separate round trip.
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokens.map(({ token }) => ({ to: token, ...message }))),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Expo answers 200 with per-device tickets even when a device is stale, so
    // a non-200 is about the request itself. Read as text: an error page is
    // not JSON, and this must not throw on the way to the log.
    if (!response.ok) {
      log.warn(
        { status: response.status, body: (await response.text()).slice(0, 500) },
        `${kind} push refused`,
      );
      return;
    }
    log.info({ devices: tokens.length, memoryId }, `${kind} push sent`);
  } catch (error) {
    // Nothing here may reach what was already committed.
    log.warn({ err: error }, `${kind} push failed`);
  }
}

/**
 * Tells somebody they were added to a memory (decision-06). Never throws and
 * never makes the caller wait on anything but this: it is called **after** the
 * membership is committed, so the person is a member whether or not this
 * lands — see `send`.
 */
export async function notifyInvited(
  log: FastifyBaseLogger,
  invitee: string,
  inviter: string,
  memory: { id: string; title: string },
): Promise<void> {
  // Present tense on purpose: «добавил» would misgender half the people who
  // ever send this (decision-06's own example reads «Аня добавила»), and
  // «добавил(а)» reads like a form. «приглашает» agrees with nobody, so the
  // one string is right for every inviter. The call to upload is part of the
  // notification, not decoration — it is what decision-06 asks it to do.
  // `data` is what the app reads to open straight at this memory's upload
  // screen — the whole point of the notification (doc-01).
  const message = {
    body: `${inviter} приглашает вас в «${memory.title}» — загрузите свои фото и видео`,
    data: { memoryId: memory.id },
  };
  await send(
    log,
    "invite",
    memory.id,
    message,
    () => sql<{ token: string }[]>`select token from push_tokens where user_id = ${invitee}`,
  );
}

/**
 * «Ролик готов» — to everyone in the memory, not only whoever ordered it
 * (doc-03). Called from the internal route the montage worker knocks on once it
 * has uploaded the video and marked the row `ready`; the video is there whether
 * or not this lands, so this never throws — see `send`.
 */
export async function notifyMontageReady(
  log: FastifyBaseLogger,
  memory: { id: string; title: string },
  montageId: string,
): Promise<void> {
  // Genderless like the invite line, and for the same reason — one string has
  // to be right for whoever ordered it. `data` carries both ids: the app opens
  // the memory's list of videos and puts this one on top.
  const message = {
    body: `Ролик из «${memory.title}» готов — посмотрите и поделитесь`,
    data: { memoryId: memory.id, montageId },
  };
  await send(
    log,
    "montage",
    memory.id,
    message,
    // Every device of every member, the organizer's included: a video is the
    // reward for everyone who brought material, so nobody is left off.
    () => sql<{ token: string }[]>`
      select pt.token from push_tokens pt
      join memory_members mm on mm.user_id = pt.user_id
      where mm.memory_id = ${memory.id}
    `,
  );
}

/** Device registration. Mounted from `buildApp` after `authPlugin`. */
export function pushRoutes(app: FastifyInstance) {
  app.post<{ Body: { token: string; platform?: string } }>(
    "/me/push-tokens",
    { preHandler: app.authenticate, schema: { body: registerBody } },
    async (request) => {
      const { token, platform } = request.body;
      // The token is the key, so the same device registering twice is one row
      // — and a device that changed hands moves to whoever holds it now,
      // rather than keeping the previous owner subscribed to their memories.
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
