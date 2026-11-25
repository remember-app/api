import { config } from "../../config.ts";

export type PushMessage = {
  token: string;
  title?: string;
  body: string;
  data?: Record<string, string>;
};

export type PushResult = {
  ok: boolean;
  status: number | null;
  error: string | null;
  deadTokens: string[];
};

type Ticket = {
  status?: string;
  details?: { error?: string };
};

export async function sendPush(messages: PushMessage[]): Promise<PushResult> {
  const url = config.push.url();
  if (!url || messages.length === 0) return { ok: true, status: null, error: null, deadTokens: [] };
  const deadTokens: string[] = [];
  for (let from = 0; from < messages.length; from += config.push.batch) {
    const batch = messages.slice(from, from + config.push.batch);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        batch.map((message) => ({
          to: message.token,
          title: message.title,
          body: message.body,
          data: message.data,
        })),
      ),
      signal: AbortSignal.timeout(config.push.timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: (await response.text()).slice(0, 500),
        deadTokens,
      };
    }
    const body = (await response.json().catch(() => null)) as { data?: Ticket[] } | null;
    const tickets = body?.data ?? [];
    tickets.forEach((ticket, index) => {
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        const token = batch[index]?.token;
        if (token) deadTokens.push(token);
      }
    });
  }
  return { ok: true, status: null, error: null, deadTokens };
}
