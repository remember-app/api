import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { checkStorage } from "../../scripts/storage-check.ts";
import { maxFileBytes, partBytes } from "./config.ts";
import { abortUploads, deleteObjects } from "./r2.ts";

/**
 * The requests the api sends the object store, held to the form Google Cloud
 * Storage's XML API accepts (docs/media.md, «Хранилище: Google Cloud Storage»).
 * The whole life of a file is played through a recorder in front of MinIO: it
 * has to go through there for real, and every request that went is then read
 * back against what Google was checked to take.
 */

const endpoint = process.env.R2_ENDPOINT;
afterEach(() => {
  if (endpoint === undefined) delete process.env.R2_ENDPOINT;
  else process.env.R2_ENDPOINT = endpoint;
});

type Seen = { method: string; url: URL; headers: IncomingHttpHeaders; body: string };

/** A server on a free port that remembers every request before `answer` replies to it. */
async function serve(answer: (seen: Seen, body: Buffer, reply: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const one = {
      method: incoming.method ?? "",
      url: new URL(incoming.url ?? "/", "http://recorded"),
      headers: incoming.headers,
      // Only the complete request's XML is read back; a part is megabytes of nothing.
      body: incoming.method === "POST" ? body.toString() : "",
    };
    seen.push(one);
    answer(one, body, reply);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

/**
 * Passed on untouched, `Host` included: the signature covers the recorder's own
 * address, and MinIO checks it against the header it is sent.
 */
const forwardTo =
  (upstream: URL) =>
  ({ method, url, headers }: Seen, body: Buffer, reply: ServerResponse) => {
    const out = request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method,
        headers,
        path: url.pathname + url.search,
      },
      (answer) => {
        reply.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(reply);
      },
    );
    out.on("error", () => reply.writeHead(502).end());
    out.end(body);
  };

/** A request named by its method and the query keys that make it the call it is. */
const call = ({ method, url }: Seen) => [method, ...[...url.searchParams.keys()].sort()].join(" ");

/**
 * The calls checked against Google's XML API reference, one per operation the
 * api has. A call outside this list is one nobody has checked with Google yet:
 * check it, write down what Google says in docs/media.md, then add it here.
 */
const checkedCalls = ["DELETE", "DELETE uploadId", "HEAD", "POST uploadId", "POST uploads"];

test("every request the api makes is one Google takes, and a file's whole life goes through", async () => {
  const bucket = process.env.R2_BUCKET;
  const region = process.env.R2_REGION?.trim() || "auto";
  const recorder = await serve(forwardTo(new URL(endpoint ?? "")));
  process.env.R2_ENDPOINT = recorder.endpoint;
  try {
    await checkStorage(`r2-test/${randomUUID()}`, () => {});
  } finally {
    recorder.close();
  }

  // Signed by the api with its key, or presigned for the phone — nothing else
  // reached the store.
  const signed = recorder.seen.filter((one) => one.headers.authorization);
  const presigned = recorder.seen.filter((one) => one.url.searchParams.has("X-Amz-Signature"));
  expect(signed.length + presigned.length).toBe(recorder.seen.length);

  expect([...new Set(signed.map(call))].sort()).toEqual(checkedCalls);
  for (const one of signed) {
    // Path-style: `<endpoint>/<bucket>/<key>`, which Google serves beside the
    // bucket-in-the-hostname form.
    expect(one.url.pathname.startsWith(`/${bucket}/`)).toBe(true);
    // SigV4 with an HMAC key, in the scope Google takes for S3 requests.
    expect(one.headers.authorization).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=[^/]+/\\d{8}/${region}/s3/aws4_request, ` +
          "SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$",
      ),
    );
    // No extension header beyond the two the signature needs. Google answers
    // one it does not know — the `x-amz-checksum-*` family the AWS SDKs send
    // since 2025 above all — with `SignatureDoesNotMatch`.
    expect(
      Object.keys(one.headers)
        .filter((name) => /^(x-amz-|x-goog-|amz-sdk-)/.test(name))
        .sort(),
    ).toEqual(["x-amz-content-sha256", "x-amz-date"]);
    // The payload is not hashed; a streaming or trailer value is not one
    // Google names.
    expect(one.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    // Chunked bodies need a header of their own at Google; a POST without a
    // length is a 411 there.
    expect(one.headers["transfer-encoding"]).toBeUndefined();
    if (one.method === "POST") {
      expect(one.headers["content-length"]).toBe(String(Buffer.byteLength(one.body)));
    }
  }

  // The parts in ascending order however they were reported, each receipt
  // quoted, and said to be XML: Google's reference names `application/xml`,
  // and a string body goes out as `text/plain` unless told.
  const complete = signed.filter((one) => call(one) === "POST uploadId");
  expect(complete).toHaveLength(1);
  expect(complete[0]?.headers["content-type"]).toBe("application/xml");
  expect(complete[0]?.body).toMatch(
    /^<CompleteMultipartUpload>(<Part><PartNumber>\d+<\/PartNumber><ETag>"[0-9a-f]{32}"<\/ETag><\/Part>)+<\/CompleteMultipartUpload>$/,
  );
  expect([...(complete[0]?.body ?? "").matchAll(/<PartNumber>(\d+)/g)].map((m) => m[1])).toEqual([
    "1",
    "2",
  ]);

  // The links: signed over the host alone, so the phone needs to send no
  // header in particular, and no longer-lived than Google's seven days.
  expect(new Set(presigned.map((one) => one.method))).toEqual(new Set(["PUT", "GET"]));
  for (const one of presigned) {
    const query = one.url.searchParams;
    expect(one.url.pathname.startsWith(`/${bucket}/`)).toBe(true);
    expect([...query.keys()].filter((name) => name.startsWith("X-Amz-")).sort()).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
    ]);
    expect(query.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(query.get("X-Amz-SignedHeaders")).toBe("host");
    expect(query.get("X-Amz-Credential")).toMatch(new RegExp(`/\\d{8}/${region}/s3/aws4_request$`));
    expect(Number(query.get("X-Amz-Expires"))).toBeLessThanOrEqual(7 * 24 * 3600);
    if (one.method === "PUT") {
      expect(Number(query.get("partNumber"))).toBeGreaterThanOrEqual(1);
      expect(query.get("uploadId")).toBeTruthy();
    }
  }

  // The part size the phones are handed: at least Google's 5 MiB floor (the
  // run above already sent one full part and completed), at most its 5 GiB, and
  // the largest file allowed fits in its 10 000 parts.
  expect(partBytes()).toBeLessThanOrEqual(5 * 1024 ** 3);
  expect(Math.ceil(maxFileBytes() / partBytes())).toBeLessThanOrEqual(10_000);
}, 60_000);

test("a key or an upload that is already gone is no failure — Google answers 404 where MinIO answers 204", async () => {
  const google = await serve((_, __, reply) => {
    reply.writeHead(404, { "content-type": "application/xml" });
    reply.end("<Error><Code>NoSuchKey</Code></Error>");
  });
  process.env.R2_ENDPOINT = google.endpoint;
  try {
    await expect(deleteObjects(["gone"])).resolves.toBeUndefined();
    await expect(abortUploads([{ key: "gone", uploadId: "gone" }])).resolves.toBeUndefined();
  } finally {
    google.close();
  }
  expect(google.seen.map(call)).toEqual(["DELETE", "DELETE uploadId"]);
});
