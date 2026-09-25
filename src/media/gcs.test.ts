import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  abortUploads,
  completeUpload,
  createUpload,
  deleteObjects,
  downloadUrl,
  headSize,
  partUrls,
  storageConfigured,
} from "./r2.ts";

/**
 * The `google` driver against a Google stood in for by a stubbed `fetch`:
 * there is no emulator of its multipart XML API, so what is held here is the
 * form of every request and link, checked against Google's reference and the
 * live run of TASK-328 (docs/media.md, «Хранилище: Google Cloud Storage»).
 * The key is made here and is nobody's.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const email = "remember@test-project.iam.gserviceaccount.com";
const bucket = "cdn.example.com";
const prefix = "remember/dev-media";
const id = "0b6f0c1e-7a4b-4d2e-9d3c-5f1a2b3c4d5e";
const key = `originals/${id}`;
const object = `https://storage.googleapis.com/${bucket}/${prefix}/${key}`;

const settings = (overrides: Record<string, string> = {}) => {
  for (const [name, value] of Object.entries({
    STORAGE_DRIVER: "google",
    GOOGLE_STORAGE_BUCKET: bucket,
    GOOGLE_STORAGE_PREFIX: prefix,
    // A key id of its own every time: the driver is built once per value of
    // the settings, so each test starts with no token held.
    GOOGLE_STORAGE_CREDENTIALS: JSON.stringify({
      type: "service_account",
      private_key_id: randomUUID(),
      client_email: email,
      private_key: pem,
    }),
    ...overrides,
  })) {
    vi.stubEnv(name, value);
  }
};
beforeEach(() => settings());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Sent = {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
  signal?: AbortSignal | null;
};

/**
 * Google as the api sees it. `answer` replies to what it wants to and leaves
 * the rest (`undefined`) to the defaults: a fresh token, numbered from 1, for
 * every token request, and `204` for everything else.
 */
function fakeGoogle(answer: (sent: Sent) => Response | undefined = () => undefined) {
  const sent: Sent[] = [];
  let issued = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const one = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: await request.text(),
      signal: init.signal,
    };
    sent.push(one);
    const replied = answer(one);
    if (replied) return replied;
    if (one.url.host !== "oauth2.googleapis.com") return new Response(null, { status: 204 });
    issued += 1;
    return Response.json({ access_token: `ya29.token-${issued}`, expires_in: 3599 });
  });
  return {
    sent,
    storage: () => sent.filter((one) => one.url.host === "storage.googleapis.com"),
    tokens: () => sent.filter((one) => one.url.host === "oauth2.googleapis.com"),
  };
}

const xml = (status: number, code: string) =>
  new Response(`<?xml version='1.0' encoding='UTF-8'?><Error><Code>${code}</Code></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });

describe("links", () => {
  const at = new Date("2026-09-25T10:15:00Z");

  /**
   * The canonical request is written out by hand from Google's V4 reference
   * and not rebuilt by the code under test; the signature over it is checked
   * with the public half of the key. And the link *is* that request: the path
   * and the query the phone sends are the ones that were signed.
   */
  function expectSignedOver(link: string, canonical: string[]) {
    const signature = new URL(link).searchParams.get("X-Goog-Signature") ?? "";
    const toSign = [
      "GOOG4-RSA-SHA256",
      "20260925T101500Z",
      "20260925/auto/storage/goog4_request",
      createHash("sha256").update(canonical.join("\n")).digest("hex"),
    ].join("\n");
    expect(verify("sha256", Buffer.from(toSign), publicKey, Buffer.from(signature, "hex"))).toBe(
      true,
    );
    expect(link).toBe(
      `https://storage.googleapis.com${canonical[1]}?${canonical[2]}&X-Goog-Signature=${signature}`,
    );
  }

  const signing =
    "X-Goog-Algorithm=GOOG4-RSA-SHA256" +
    "&X-Goog-Credential=remember%40test-project.iam.gserviceaccount.com%2F20260925%2Fauto%2Fstorage%2Fgoog4_request" +
    "&X-Goog-Date=20260925T101500Z";

  test("a part link is signed over its part number and upload id, with no request made", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    const google = fakeGoogle();
    // `~` stays, `=`, `+`, `/` and `*` are encoded — the last one being where
    // encodeURIComponent and RFC 3986 part ways.
    const links = await partUrls(key, "ABPnzm5~x_y-z=+/*", 3, 3600);

    expect(links).toHaveLength(3);
    expectSignedOver(links[1] ?? "", [
      "PUT",
      `/${bucket}/${prefix}/${key}`,
      // By code point: every capital before any small letter.
      `${signing}&X-Goog-Expires=3600&X-Goog-SignedHeaders=host` +
        "&partNumber=2&uploadId=ABPnzm5~x_y-z%3D%2B%2F%2A",
      "host:storage.googleapis.com",
      "",
      "host",
      "UNSIGNED-PAYLOAD",
    ]);
    expect(google.sent).toEqual([]);
  });

  test("a download link is the same signature over GET and nothing else", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    fakeGoogle();
    expectSignedOver(await downloadUrl(`thumbnails/${id}.jpg`, 900), [
      "GET",
      `/${bucket}/${prefix}/thumbnails/${id}.jpg`,
      `${signing}&X-Goog-Expires=900&X-Goog-SignedHeaders=host`,
      "host:storage.googleapis.com",
      "",
      "host",
      "UNSIGNED-PAYLOAD",
    ]);
  });

  test("a link outliving Google's seven days is refused rather than handed out", async () => {
    await expect(downloadUrl(key, 7 * 24 * 3600)).resolves.toContain("X-Goog-Expires=604800");
    await expect(downloadUrl(key, 7 * 24 * 3600 + 1)).rejects.toThrow(/cannot outlive/);
  });

  test("every key shape the product makes goes out as written, in the link and on the wire", async () => {
    // A trailing slash on the prefix is the same prefix, not an empty segment.
    settings({ GOOGLE_STORAGE_PREFIX: `${prefix}/` });
    const google = fakeGoogle();
    const keys = [
      `originals/${id}`,
      `music/${id}`,
      `thumbnails/${id}.jpg`,
      `previews/${id}.mp4`,
      `previews/${id}.jpg`,
      `montages/${id}.mp4`,
      `montages/${id}.jpg`,
      "tracks/bright.mp3",
      `${id}/object`,
      "a_b-c.d/e",
    ];
    for (const one of keys) {
      expect(new URL(await downloadUrl(one, 900)).pathname).toBe(`/${bucket}/${prefix}/${one}`);
      await headSize(one);
      expect(google.storage().at(-1)?.url.pathname).toBe(`/${bucket}/${prefix}/${one}`);
    }
  });
});

describe("the access token", () => {
  test("is a JWT the key signed, bought once for callers who ask together", async () => {
    const google = fakeGoogle((one) =>
      one.method === "HEAD"
        ? new Response(null, { headers: { "content-length": "1234" } })
        : undefined,
    );
    const before = Math.floor(Date.now() / 1000);
    expect(await Promise.all([headSize(key), headSize(key), headSize(key)])).toEqual([
      1234, 1234, 1234,
    ]);
    await headSize(key);

    expect(google.tokens()).toHaveLength(1);
    const [bought] = google.tokens();
    expect(bought?.method).toBe("POST");
    expect(bought?.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(bought?.headers.get("content-type")).toMatch(/^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(bought?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [header = "", claims = "", signature = ""] = (form.get("assertion") ?? "").split(".");
    const read = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
    expect(read(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const { iat, exp, ...rest } = read(claims);
    expect(rest).toEqual({
      iss: email,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(iat).toBeGreaterThanOrEqual(before);
    expect(exp - iat).toBe(3600);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);

    for (const one of google.storage()) {
      expect(one.headers.get("authorization")).toBe("Bearer ya29.token-1");
    }
  });

  test("is bought again five minutes before it runs out, and not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-09-25T10:00:00Z").getTime();
    vi.setSystemTime(start);
    const google = fakeGoogle();
    const bearer = async () => {
      await deleteObjects([key]);
      return google.storage().at(-1)?.headers.get("authorization");
    };

    expect(await bearer()).toBe("Bearer ya29.token-1");
    // Google said 3599 s; five minutes of that are not used.
    vi.setSystemTime(start + (3599 - 300) * 1000 - 1);
    expect(await bearer()).toBe("Bearer ya29.token-1");
    vi.setSystemTime(start + (3599 - 300) * 1000);
    expect(await bearer()).toBe("Bearer ya29.token-2");
    expect(google.tokens()).toHaveLength(2);
  });

  test("a refusal is heard with Google's reason, is not kept, and carries no secret", async () => {
    let refuse = true;
    const google = fakeGoogle((one) => {
      if (one.url.host !== "oauth2.googleapis.com" || !refuse) return undefined;
      refuse = false;
      return Response.json(
        { error: "invalid_grant", error_description: "Invalid JWT Signature." },
        { status: 400 },
      );
    });

    const failure = await deleteObjects([key]).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/Google refused an access token: 400 .*invalid_grant/);
    expect(String(failure)).not.toContain(google.tokens()[0]?.body.slice(-40));
    expect(String(failure)).not.toContain("PRIVATE KEY");
    expect(google.storage()).toEqual([]);

    await deleteObjects([key]);
    expect(google.tokens()).toHaveLength(2);
    expect(google.storage()).toHaveLength(1);
  });

  test("an answer without a token is an error that does not quote the answer", async () => {
    fakeGoogle((one) =>
      one.url.host === "oauth2.googleapis.com"
        ? Response.json({ access_token: "ya29.half-a-secret" })
        : undefined,
    );
    const failure = await headSize(key).catch((error: Error) => error);
    expect(String(failure)).toMatch(/without a token/);
    expect(String(failure)).not.toContain("ya29");
  });
});

describe("requests", () => {
  test("each one is the call Google was checked to take, on the token and nothing else", async () => {
    const google = fakeGoogle((one) => {
      if (one.url.host !== "storage.googleapis.com") return undefined;
      if (one.url.search === "?uploads") {
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>ABPnzm5-up_1</UploadId></InitiateMultipartUploadResult>",
        );
      }
      if (one.method === "POST") return new Response("<CompleteMultipartUploadResult/>");
      if (one.method === "HEAD") return new Response(null, { headers: { "content-length": "42" } });
      return undefined;
    });

    expect(await createUpload(key)).toBe("ABPnzm5-up_1");
    await completeUpload(key, "ABPnzm5-up/1", [
      { part_number: 2, etag: '"b2"' },
      { part_number: 1, etag: "a1" },
    ]);
    expect(await headSize(key)).toBe(42);
    await abortUploads([{ key, uploadId: "ABPnzm5-up/1" }]);
    await deleteObjects([key]);

    expect(google.storage().map((one) => `${one.method} ${one.url.href}`)).toEqual([
      `POST ${object}?uploads`,
      `POST ${object}?uploadId=ABPnzm5-up%2F1`,
      `HEAD ${object}`,
      `DELETE ${object}?uploadId=ABPnzm5-up%2F1`,
      `DELETE ${object}`,
    ]);
    for (const one of google.storage()) {
      expect(one.headers.get("authorization")).toBe("Bearer ya29.token-1");
      // A try that hangs is cut off rather than waited on forever.
      expect(one.signal).toBeInstanceOf(AbortSignal);
    }
    const complete = google.storage()[1];
    expect(complete?.headers.get("content-type")).toBe("application/xml");
    expect(complete?.body).toBe(
      "<CompleteMultipartUpload>" +
        '<Part><PartNumber>1</PartNumber><ETag>"a1"</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>"b2"</ETag></Part>' +
        "</CompleteMultipartUpload>",
    );
    expect(google.storage()[0]?.body).toBe("");
  });

  test("a key or an upload already gone is no failure: 404 as much as 204", async () => {
    const google = fakeGoogle((one) =>
      one.url.host !== "storage.googleapis.com"
        ? undefined
        : one.url.search
          ? xml(404, "NoSuchUpload")
          : xml(404, "NoSuchKey"),
    );
    await expect(deleteObjects([key])).resolves.toBeUndefined();
    await expect(abortUploads([{ key, uploadId: "gone" }])).resolves.toBeUndefined();
    await expect(headSize(key)).resolves.toBeNull();
    expect(google.storage()).toHaveLength(3);
  });

  test("a refusal is heard with its status and Google's code, and never with the token", async () => {
    fakeGoogle((one) => {
      if (one.url.host !== "storage.googleapis.com") return undefined;
      if (one.url.pathname.endsWith("/kept")) return new Response(null, { status: 204 });
      return one.method === "POST" && one.url.search !== "?uploads"
        ? xml(400, "InvalidArgument")
        : xml(403, "AccessDenied");
    });
    const heard = (promise: Promise<unknown>) =>
      promise.then(
        () => "",
        (error: Error) => {
          expect(error.message).not.toContain("ya29");
          return error.message;
        },
      );

    expect(await heard(createUpload(key))).toMatch(
      /refused a multipart upload: 403 .*AccessDenied/,
    );
    expect(await heard(completeUpload(key, "u", [{ part_number: 1, etag: "a" }]))).toMatch(
      /refused to complete the upload: 400 .*InvalidArgument/,
    );
    expect(await heard(headSize(key))).toMatch(/refused a HEAD: 403/);
    expect(await heard(deleteObjects([key, "originals/kept"]))).toMatch(
      /refused 1 of 2 deletes: 403/,
    );
    expect(await heard(abortUploads([{ key, uploadId: "u" }]))).toMatch(
      /refused 1 of 1 aborts: 403/,
    );
  });

  test("a 5xx or a 429 is tried again, three tries at most, and so is no answer", async () => {
    let answers = [503, 429, 200];
    const google = fakeGoogle((one) =>
      one.url.host === "storage.googleapis.com"
        ? new Response(null, { status: answers.shift() ?? 503, headers: { "content-length": "7" } })
        : undefined,
    );
    expect(await headSize(key)).toBe(7);
    expect(google.storage()).toHaveLength(3);

    answers = [];
    await expect(headSize(key)).rejects.toThrow(/refused a HEAD: 503/);
    expect(google.storage()).toHaveLength(6);

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(deleteObjects([key])).rejects.toThrow(
      `DELETE /${bucket}/${prefix}/${key} failed 3 times: fetch failed`,
    );
  }, 15_000);
});

describe("the prefix", () => {
  const outside = [
    "",
    "/originals/x",
    "originals/../../other-project/x",
    "..",
    "originals/./x",
    "originals//x",
    "originals/x/",
    "originals/x\u0000",
    "originals/x\n",
    "originals/%2e%2e/x",
    "originals/x y",
    // Full names, the product's own and the checks' beside it, passed where a
    // logical key belongs.
    `${prefix}/originals/x`,
    "remember/dev-check/x",
  ];
  const operations = [
    (one: string) => createUpload(one),
    (one: string) => partUrls(one, "u", 2, 3600),
    (one: string) => completeUpload(one, "u", [{ part_number: 1, etag: "a" }]),
    (one: string) => headSize(one),
    (one: string) => downloadUrl(one, 900),
    (one: string) => abortUploads([{ key: one, uploadId: "u" }]),
    (one: string) => deleteObjects([one]),
  ];

  test("a key that is not a plain key under it is refused before anything goes to Google", async () => {
    const google = fakeGoogle();
    for (const one of outside) {
      for (const operation of operations) {
        await expect(operation(one), JSON.stringify(one)).rejects.toThrow(
          /is not a plain key under remember\/dev-media\//,
        );
      }
    }
    expect(google.sent).toEqual([]);
  });

  test("whatever a batch holds, nothing it sends lands outside", async () => {
    const google = fakeGoogle();
    await expect(deleteObjects([key, "originals/../../../x", `music/${id}`])).rejects.toThrow();
    await expect(
      abortUploads([
        { key, uploadId: "u" },
        { key: "../x", uploadId: "u" },
      ]),
    ).rejects.toThrow();
    for (const operation of operations) await operation(key).catch(() => {});
    for (const one of google.storage()) {
      expect(one.url.pathname.startsWith(`/${bucket}/${prefix}/`)).toBe(true);
    }
    expect(google.storage().length).toBeGreaterThan(0);
  });
});

describe("settings", () => {
  const refused = (overrides: Record<string, string>) => {
    settings(overrides);
    return () => storageConfigured();
  };

  test("google with anything missing or broken throws, naming the setting and never the key", () => {
    expect(refused({ GOOGLE_STORAGE_PREFIX: "" })).toThrow(/GOOGLE_STORAGE_PREFIX is not set/);
    expect(refused({ GOOGLE_STORAGE_PREFIX: " / " })).toThrow(/GOOGLE_STORAGE_PREFIX is not set/);
    expect(refused({ GOOGLE_STORAGE_PREFIX: "../other" })).toThrow(/is not a plain path/);
    expect(refused({ GOOGLE_STORAGE_PREFIX: "/remember" })).toThrow(/is not a plain path/);
    expect(refused({ GOOGLE_STORAGE_BUCKET: "" })).toThrow(/GOOGLE_STORAGE_BUCKET is not set/);
    expect(refused({ GOOGLE_STORAGE_CREDENTIALS: "  " })).toThrow(
      /GOOGLE_STORAGE_CREDENTIALS is not set/,
    );
    const quoted = /secret-bytes/;
    expect(refused({ GOOGLE_STORAGE_CREDENTIALS: '{"private_key": "secret-bytes' })).toThrow(
      /is not JSON/,
    );
    expect(refused({ GOOGLE_STORAGE_CREDENTIALS: '{"private_key": "secret-bytes' })).not.toThrow(
      quoted,
    );
    expect(
      refused({ GOOGLE_STORAGE_CREDENTIALS: JSON.stringify({ client_email: email }) }),
    ).toThrow(/no client_email or private_key/);
    const broken = JSON.stringify({
      client_email: email,
      private_key: "-----BEGIN PRIVATE KEY-----\nsecret-bytes\n-----END PRIVATE KEY-----\n",
    });
    expect(refused({ GOOGLE_STORAGE_CREDENTIALS: broken })).toThrow(/not a readable PEM key/);
    expect(refused({ GOOGLE_STORAGE_CREDENTIALS: broken })).not.toThrow(quoted);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(
      refused({
        GOOGLE_STORAGE_CREDENTIALS: JSON.stringify({
          client_email: email,
          private_key: ec.export({ type: "pkcs8", format: "pem" }).toString(),
        }),
      }),
    ).toThrow(/not an RSA key/);
    expect(refused({ STORAGE_DRIVER: "gcs" })).toThrow(/STORAGE_DRIVER is "gcs"/);
  });

  test("google set right is configured; s3 stays the default and reads R2_* as it always has", () => {
    expect(storageConfigured()).toBe(true);
    settings({ STORAGE_DRIVER: " Google " });
    expect(storageConfigured()).toBe(true);
    for (const driver of ["", "s3"]) {
      vi.stubEnv("STORAGE_DRIVER", driver);
      vi.stubEnv("R2_ENDPOINT", "");
      expect(storageConfigured()).toBe(false);
      vi.stubEnv("R2_ENDPOINT", "http://localhost:9000");
      vi.stubEnv("R2_BUCKET", "remember");
      vi.stubEnv("R2_ACCESS_KEY_ID", "remember");
      vi.stubEnv("R2_SECRET_ACCESS_KEY", "remember-secret");
      expect(storageConfigured()).toBe(true);
    }
  });

  test("the server does not start on google without a prefix, and says why", () => {
    const started = spawnSync(process.execPath, ["src/server.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: "postgres://nobody@127.0.0.1:1/nothing",
        PORT: "0",
        GOOGLE_STORAGE_PREFIX: "",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(started.status).not.toBe(0);
    expect(started.stderr).toContain(
      "STORAGE_DRIVER is google, but GOOGLE_STORAGE_PREFIX is not set",
    );
    expect(started.stderr).not.toContain("PRIVATE KEY");
  });
});
