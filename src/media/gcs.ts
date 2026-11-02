import { createHash, createPrivateKey, type KeyObject, sign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { env } from "../auth/config.ts";
import type { Store } from "./r2.ts";

const HOST = "storage.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EARLY_MS = 5 * 60000;
const MAX_TTL = 7 * 24 * 3600;
const TIMEOUT_MS = 30000;
const TRIES = 3;
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const plain = (path: string) => path.split("/").every((part) => /^[\w-][\w.-]*$/.test(part));
const signAsync = promisify(sign);
type Settings = {
  email: string;
  privateKey: KeyObject;
  bucket: string;
  prefix: string;
};
function settings(): Settings {
  const credentials = env("GOOGLE_STORAGE_CREDENTIALS");
  const bucket = env("GOOGLE_STORAGE_BUCKET");
  const prefix = env("GOOGLE_STORAGE_PREFIX")?.replace(/\/+$/, "");
  const wrong = (what: string) => new Error(`STORAGE_DRIVER is google, but ${what}`);
  if (!credentials) throw wrong("GOOGLE_STORAGE_CREDENTIALS is not set");
  if (!bucket) throw wrong("GOOGLE_STORAGE_BUCKET is not set");
  if (!prefix) throw wrong("GOOGLE_STORAGE_PREFIX is not set");
  if (!plain(prefix)) {
    throw wrong(`GOOGLE_STORAGE_PREFIX ${JSON.stringify(prefix)} is not a plain path`);
  }
  let key: {
    client_email?: unknown;
    private_key?: unknown;
  } | null;
  try {
    key = JSON.parse(credentials);
  } catch {
    throw wrong("GOOGLE_STORAGE_CREDENTIALS is not JSON — the key file goes in whole, on one line");
  }
  if (typeof key?.client_email !== "string" || typeof key.private_key !== "string") {
    throw wrong("GOOGLE_STORAGE_CREDENTIALS has no client_email or private_key");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(key.private_key);
  } catch {
    throw wrong("the private_key in GOOGLE_STORAGE_CREDENTIALS is not a readable PEM key");
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw wrong("the private_key in GOOGLE_STORAGE_CREDENTIALS is not an RSA key");
  }
  return { email: key.client_email, privateKey, bucket, prefix };
}
async function send(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === TRIES;
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (last || (response.status !== 429 && response.status < 500)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (last) {
        const why = error instanceof Error ? error.message : String(error);
        throw new Error(`${init.method} ${new URL(url).pathname} failed ${TRIES} times: ${why}`, {
          cause: error,
        });
      }
    }
    await sleep(500 * 2 ** (attempt - 1));
  }
}
function tokens({ email, privateKey }: Settings): () => Promise<string> {
  let held:
    | {
        token: string;
        until: number;
      }
    | undefined;
  let buying: Promise<string> | undefined;
  async function buy() {
    const now = Date.now();
    const iat = Math.floor(now / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = {
      iss: email,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    };
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}`;
    const signature = (await signAsync("sha256", Buffer.from(unsigned), privateKey)).toString(
      "base64url",
    );
    const response = await send(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Google refused an access token: ${response.status} ${await response.text()}`,
      );
    }
    const { access_token: token, expires_in: seconds } = (await response
      .json()
      .catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof token !== "string" || typeof seconds !== "number" || !(seconds > 0)) {
      throw new Error("Google answered the token request without a token");
    }
    held = { token, until: now + seconds * 1000 - EARLY_MS };
    return token;
  }
  return () => {
    if (held && Date.now() < held.until) return Promise.resolve(held.token);
    buying ??= buy().finally(() => {
      buying = undefined;
    });
    return buying;
  };
}
function build(given: Settings): Store {
  const { email, privateKey, bucket, prefix } = given;
  const token = tokens(given);
  const root = prefix.split("/")[0];
  const objectName = (key: string) => {
    if (!plain(key) || key.split("/")[0] === root) {
      throw new Error(`storage key ${JSON.stringify(key)} is not a plain key under ${prefix}/`);
    }
    return `/${encode(bucket)}/${`${prefix}/${key}`.split("/").map(encode).join("/")}`;
  };
  return {
    call: async (method, key, query, init) => {
      const url = `https://${HOST}${objectName(key)}${query ? `?${query}` : ""}`;
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${await token()}`);
      return send(url, { ...init, method, headers });
    },
    link: async (method, key, ttl, query = {}) => {
      const resource = objectName(key);
      if (ttl > MAX_TTL) throw new Error(`a link cannot outlive Google's ${MAX_TTL} s: ${ttl}`);
      const date = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
      const scope = `${date.slice(0, 8)}/auto/storage/goog4_request`;
      const canonicalQuery = Object.entries({
        ...query,
        "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
        "X-Goog-Credential": `${email}/${scope}`,
        "X-Goog-Date": date,
        "X-Goog-Expires": String(ttl),
        "X-Goog-SignedHeaders": "host",
      })
        .map(([name, value]) => [encode(name), encode(value)] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, value]) => `${name}=${value}`)
        .join("&");
      const request = [
        method,
        resource,
        canonicalQuery,
        `host:${HOST}`,
        "",
        "host",
        "UNSIGNED-PAYLOAD",
      ];
      const hashed = createHash("sha256").update(request.join("\n")).digest("hex");
      const toSign = ["GOOG4-RSA-SHA256", date, scope, hashed].join("\n");
      const signature = await signAsync("sha256", Buffer.from(toSign), privateKey);
      return `https://${HOST}${resource}?${canonicalQuery}&X-Goog-Signature=${signature.toString("hex")}`;
    },
  };
}
let current:
  | {
      settings: string;
      store: Store;
    }
  | undefined;
export function googleStore(): Store {
  const raw = ["GOOGLE_STORAGE_CREDENTIALS", "GOOGLE_STORAGE_BUCKET", "GOOGLE_STORAGE_PREFIX"]
    .map((name) => process.env[name] ?? "")
    .join("\n");
  if (current?.settings !== raw) current = { settings: raw, store: build(settings()) };
  return current.store;
}
