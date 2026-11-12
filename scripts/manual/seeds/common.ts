export const API = (process.env.API_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export const day = 86_400_000;
export const daysAgo = (days: number): Date => new Date(Date.now() - days * day);
export const gb = (count: number): number => count * 1024 ** 3;

type Answer<T> = T & { error?: string };

export type Token = string;

async function call<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  token?: Token,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => null)) as Answer<T> | null;
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(answer)}`);
  }
  if (answer === null) throw new Error(`${method} ${path} → empty answer`);
  return answer;
}

export const get = <T>(path: string, token: Token) => call<T>(path, "GET", token);
export const post = <T>(path: string, token: Token | undefined, body?: unknown) =>
  call<T>(path, "POST", token, body);
export const patch = <T>(path: string, token: Token, body: unknown) =>
  call<T>(path, "PATCH", token, body);
export const del = <T>(path: string, token: Token) => call<T>(path, "DELETE", token);

export type Person = {
  email: string;
  username: string;
  name: string;
  language: "ru" | "en";
};

export type Asset = {
  file: string;
  kind: "photo" | "video" | "audio";
  contentType: string;
  capturedAt?: Date;
  daysAgo?: number;
  description?: string;
  place: { latitude: number; longitude: number } | null;
  labels: string[];
  durationSeconds?: number;
  by?: string;
};

export type MontageOrder = {
  targetSeconds: number;
  prompt: string | null;
  dimensions: { width: number; height: number };
  include?: number[];
};

export type Project = {
  title: string;
  owner: string;
  eventStart: Date;
  eventEnd: Date | null;
  members: { username: string; role: "admin" | "contributor" | "viewer"; contribution: string }[];
  labels: { name: string; colorHex: string; shared: boolean; owner?: string }[];
  assets: Asset[];
  montages: MontageOrder[];
};

type Session = { token: Token; user: { id: string; registered: boolean } };

export async function login(email: string): Promise<Session> {
  const started = await post<{ code?: string }>("/v1/auth/email/start", undefined, { email });
  if (!started.code) {
    throw new Error(
      "test seed needs the dev login door: start the API with EMAIL_LOGIN_DEV_BYPASS=123456",
    );
  }
  return post<Session>("/v1/auth/email/verify", undefined, { email, code: started.code });
}

export function tokenOf(tokens: Map<string, Token>, username: string): Token {
  const token = tokens.get(username);
  if (!token) throw new Error(`test seed: unknown user ${username}`);
  return token;
}
