import { createHash, createPrivateKey, type KeyObject, sign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { env } from "../auth/config.ts";
import type { Store } from "./r2.ts";

/**
 * The `google` driver: Google Cloud Storage's XML API on a service account's
 * JSON key, for a bucket nobody will hand an HMAC key for (decision-16).
 *
 * The api's own requests carry an OAuth access token, which the key buys from
 * Google; the phone's links are V4-signed with the key's RSA half, locally and
 * with no network. Both are node:crypto and fetch, and no google-auth-library:
 * a JWT and a canonical string are a dozen lines, the library a dependency tree.
 * The exact shapes were checked live against Google (TASK-328) and are written
 * down in docs/media.md, «Хранилище: Google Cloud Storage».
 *
 * Everything lives under `GOOGLE_STORAGE_PREFIX`, added in one place —
 * `objectName` — to the same logical keys the database holds on every driver.
 * The bucket is shared with other projects and public, so a key that could
 * land anywhere else is refused before a single request goes out.
 */

const HOST = "storage.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Refreshed this long before Google says it expires, so none is used on its last breath. */
const EARLY_MS = 5 * 60_000;

/** Google's own ceiling for a V4 link. */
const MAX_TTL = 7 * 24 * 3600;

/** Per try, and tries per request: a 5xx, a 429 or silence gets two more, then the caller hears. */
const TIMEOUT_MS = 30_000;
const TRIES = 3;

/** Percent-encoding as RFC 3986 and Google's canonical request spell it: all but `A-Za-z0-9-._~`. */
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Segments of letters, digits, `-`, `_` and `.`, none empty and none starting
 * with a dot. Every key the product makes fits (`originals/<uuid>`,
 * `thumbnails/<uuid>.jpg`, `tracks/bright.mp3`), and nothing that could climb
 * out of the prefix does: `..`, a leading or doubled `/`, a control character.
 */
const plain = (path: string) => path.split("/").every((part) => /^[\w-][\w.-]*$/.test(part));

const signAsync = promisify(sign);

type Settings = { email: string; privateKey: KeyObject; bucket: string; prefix: string };

/**
 * The three settings, or an error that names what is wrong — and never the
 * key: a JSON parse error quotes its input, so neither it nor the one from
 * reading the PEM goes on as a cause.
 */
function settings(): Settings {
  const credentials = env("GOOGLE_STORAGE_CREDENTIALS");
  const bucket = env("GOOGLE_STORAGE_BUCKET");
  const prefix = env("GOOGLE_STORAGE_PREFIX")?.replace(/\/+$/, "");
  const wrong = (what: string) => new Error(`STORAGE_DRIVER is google, but ${what}`);
  if (!credentials) throw wrong("GOOGLE_STORAGE_CREDENTIALS is not set");
  if (!bucket) throw wrong("GOOGLE_STORAGE_BUCKET is not set");
  // The bucket is shared: without a prefix everything would go to its root.
  if (!prefix) throw wrong("GOOGLE_STORAGE_PREFIX is not set");
  if (!plain(prefix)) {
    throw wrong(`GOOGLE_STORAGE_PREFIX ${JSON.stringify(prefix)} is not a plain path`);
  }
  let key: { client_email?: unknown; private_key?: unknown } | null;
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

/**
 * A fetch that gives up: each try has `TIMEOUT_MS`, and a 5xx, a 429 or no
 * answer at all is tried again after a pause that doubles, `TRIES` times in all.
 * What is left after that — the last answer or the last failure — is the
 * caller's.
 */
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

/**
 * An access token, bought with a JWT signed by the key — RS256 over
 * `iss`/`scope`/`aud`/`iat`/`exp`, an hour at most — and kept until shortly
 * before it runs out. Callers who ask while one is being bought wait for that
 * one instead of buying their own; a failure is not kept.
 */
function tokens({ email, privateKey }: Settings): () => Promise<string> {
  let held: { token: string; until: number } | undefined;
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
    // Not the body in the error below: it would be the token itself.
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

  /**
   * The one place the prefix is added, and the one place a key is refused. A
   * key that already starts where the prefix does (`remember/…`) is a full
   * name passed where a logical key belongs — the product's own, or the
   * checks' beside it — and is refused as well rather than nested.
   */
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

    /**
     * A V4 signed URL (GOOG4-RSA-SHA256) over `host` alone, so the phone need
     * send no header in particular. For a part, `partNumber` and `uploadId`
     * are inside the signature: the link is good for that part of that
     * upload and no other.
     */
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

/**
 * The driver for the settings as they stand, built once per value of them —
 * which keeps one token for the life of the process, and gives a test that
 * changes them a driver of its own.
 */
let current: { settings: string; store: Store } | undefined;

export function googleStore(): Store {
  const raw = ["GOOGLE_STORAGE_CREDENTIALS", "GOOGLE_STORAGE_BUCKET", "GOOGLE_STORAGE_PREFIX"]
    .map((name) => process.env[name] ?? "")
    .join("\n");
  if (current?.settings !== raw) current = { settings: raw, store: build(settings()) };
  return current.store;
}
