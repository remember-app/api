import { AwsClient } from "aws4fetch";
import { env } from "../auth/config.ts";
import { googleStore } from "./gcs.ts";

/**
 * The object store, behind one of two drivers that `STORAGE_DRIVER` picks:
 *
 * - `s3`, the default — anything that speaks S3 with an HMAC key: MinIO from
 *   `docker-compose` locally, Cloudflare R2 before that — whence the name, kept
 *   with the `R2_*` variables the stands already read — and Google's
 *   S3-compatible XML API given an HMAC key. Every bucket is addressed by path
 *   (`<endpoint>/<bucket>/<key>`).
 * - `google` — Google Cloud Storage on a service account's JSON key, with no
 *   HMAC key at all (`gcs.ts`).
 *
 * The phone sees no difference: the same presigned part links, the same etags,
 * the same «загружено». What was checked against Google and how it is held in
 * place: docs/media.md, «Хранилище: Google Cloud Storage», `r2.test.ts` and
 * `gcs.test.ts`.
 *
 * `aws4fetch` and not `@aws-sdk/client-s3`: the whole of what is needed here is
 * SigV4 and four requests, which that is 80 KB and no transitive dependencies
 * for. It is also why no checksum headers go out — the SDK adds
 * `x-amz-checksum-*` by default, and Google answers those with
 * `SignatureDoesNotMatch`. The XML is read with a regex for the same reason —
 * one tag out of one response is not a parser.
 */

/** What each driver does its own way; every operation below is written once on top of it. */
export type Store = {
  /** A request of the api's own, on the api's credentials. `query` goes out as written. */
  call(method: string, key: string, query?: string, init?: RequestInit): Promise<Response>;
  /** A link that whoever holds it may use, with no credentials, for `ttl` seconds. */
  link(
    method: "GET" | "PUT",
    key: string,
    ttl: number,
    query?: Record<string, string>,
  ): Promise<string>;
};

/** `s3` unless said otherwise; anything but the two is a typo, and a typo stops the server. */
export function storageDriver(): "s3" | "google" {
  const name = env("STORAGE_DRIVER")?.toLowerCase() ?? "s3";
  if (name === "s3" || name === "google") return name;
  throw new Error(`STORAGE_DRIVER is "${name}", and it can only be s3 or google`);
}

/** Trailing slashes trimmed: `…:9000/` + `/bucket` is a path with an empty segment. */
const endpoint = () => env("R2_ENDPOINT")?.replace(/\/+$/, "");

/**
 * Whether there is a store to sign for. On `s3`, nothing is presigned or
 * uploaded until all four `R2_*` are set: a blank one is the same
 * misconfiguration as a missing one, so the routes say so plainly instead of
 * answering as though the caller's request were at fault — the same call
 * `/auth/apple` makes when its client id is absent.
 *
 * On `google` it is never a quiet «no»: a key, bucket or prefix that is missing
 * or broken throws, and `server.ts` asks once before it listens — so a server
 * with a bad key does not start, rather than answer 503 to every upload.
 */
export function storageConfigured(): boolean {
  if (storageDriver() === "s3") {
    return Boolean(
      endpoint() && env("R2_BUCKET") && env("R2_ACCESS_KEY_ID") && env("R2_SECRET_ACCESS_KEY"),
    );
  }
  googleStore();
  return true;
}

const store = (): Store => (storageDriver() === "google" ? googleStore() : s3Store());

/**
 * R2 wants the literal `auto` for a region, Google takes any value at all,
 * MinIO signs with `us-east-1` unless told otherwise. It is a knob because
 * those disagree.
 */
function s3Store(): Store {
  const aws = new AwsClient({
    accessKeyId: env("R2_ACCESS_KEY_ID") ?? "",
    secretAccessKey: env("R2_SECRET_ACCESS_KEY") ?? "",
    service: "s3",
    region: env("R2_REGION") ?? "auto",
  });
  const url = (key: string, query = "") =>
    `${endpoint()}/${env("R2_BUCKET")}/${key}${query && `?${query}`}`;
  return {
    call: (method, key, query, init) => aws.fetch(url(key, query), { ...init, method }),
    link: async (method, key, ttl, query = {}) => {
      const params = Object.entries(query).map(
        ([name, value]) => `${name}=${encodeURIComponent(value)}`,
      );
      // signQuery puts the signature in the query string, which is what makes
      // the link usable by a phone that holds no credentials.
      const signed = await aws.sign(url(key, [...params, `X-Amz-Expires=${ttl}`].join("&")), {
        method,
        aws: { signQuery: true },
      });
      return signed.url;
    },
  };
}

/** Starts a multipart upload and answers with its id. */
export async function createUpload(key: string): Promise<string> {
  const response = await store().call("POST", key, "uploads");
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`storage refused a multipart upload: ${response.status} ${body}`);
  }
  const uploadId = body.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error(`storage started an upload without an id: ${body}`);
  return uploadId;
}

/**
 * A presigned `PUT` for every part, in order. The client slices the file by
 * the part size it was handed and sends the parts itself — the bytes never
 * pass through the API.
 */
export function partUrls(
  key: string,
  uploadId: string,
  count: number,
  ttlSeconds: number,
): Promise<string[]> {
  const signer = store();
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      signer.link("PUT", key, ttlSeconds, { partNumber: String(index + 1), uploadId }),
    ),
  );
}

/** The parts as the client reports them back: the number it sent and the store's receipt. */
export type UploadedPart = { part_number: number; etag: string };

/**
 * Seals the upload into one object. The parts must arrive in ascending order
 * and every etag must be quoted, or S3 answers `InvalidPart`.
 */
export async function completeUpload(key: string, uploadId: string, parts: UploadedPart[]) {
  const xml = [...parts]
    .sort((a, b) => a.part_number - b.part_number)
    .map(
      (part) =>
        `<Part><PartNumber>${part.part_number}</PartNumber>` +
        `<ETag>"${part.etag.replaceAll('"', "")}"</ETag></Part>`,
    )
    .join("");
  const response = await store().call("POST", key, `uploadId=${encodeURIComponent(uploadId)}`, {
    // Said outright: a string body goes out as `text/plain` otherwise, and
    // Google's reference says this request's body type is `application/xml`.
    headers: { "content-type": "application/xml" },
    body: `<CompleteMultipartUpload>${xml}</CompleteMultipartUpload>`,
  });
  const body = await response.text();
  // S3 may answer 200 and then put the failure in the body — it keeps the
  // connection warm while it assembles, so the status is written before the
  // outcome is known.
  if (!response.ok || body.includes("<Error")) {
    throw new Error(`storage refused to complete the upload: ${response.status} ${body}`);
  }
}

/** What the store actually holds, in bytes — or null if there is no such object. */
export async function headSize(key: string): Promise<number | null> {
  const response = await store().call("HEAD", key);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`storage refused a HEAD: ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) ? length : null;
}

/**
 * A presigned `GET` — the only way anything is read out of a private bucket.
 * Whoever holds the link needs no credentials and the API is not on the path
 * the bytes take, exactly as with the upload links above.
 */
export const downloadUrl = (key: string, ttlSeconds: number): Promise<string> =>
  store().link("GET", key, ttlSeconds);

/**
 * Releases uploads that will never be finished. A plain `DELETE` on the key
 * does **not** touch a multipart in progress — the parts already sent stay in
 * the bucket, billed, until the upload is aborted. That matters most where the
 * row is going too: `media_items.upload_id` is the only record of the id, so an
 * upload not aborted here can never be named by anything again, the worker's
 * hourly sweep included (montage `sweep_stale_uploads`).
 */
export const abortUploads = (uploads: { key: string; uploadId: string }[]) =>
  deleteAll(
    "aborts",
    uploads.map(({ key, uploadId }) => [key, `uploadId=${encodeURIComponent(uploadId)}`]),
  );

/**
 * Drops objects by key.
 *
 * ponytail: one request per key instead of S3's multi-object delete. That call
 * brings an XML body, a Content-MD5 header and an error shape of its own, to
 * save round trips nobody is counting. Swap it in if the slices below stop
 * being enough.
 */
export const deleteObjects = (keys: string[]) =>
  deleteAll(
    "deletes",
    keys.map((key) => [key, ""]),
  );

/** How many of those requests are in the air at once — see `deleteAll`. */
const AT_ONCE = 32;

/**
 * A `DELETE` on every `[key, query]`, and one account of what the bucket refused.
 *
 * A 404 is never a failure: a key that is not there — a record deleted before
 * the worker made its preview — and an upload already released or completed
 * after all are both the outcome the caller asked for. It is also what Google
 * answers for a missing key, where S3 and MinIO answer 204.
 *
 * In slices and not in one `Promise.all`: a memory holds up to a thousand files
 * (`memoryMaxFiles`) with three keys each, beside its videos and its music, and
 * deleting it whole would otherwise open a socket for every one of them in the
 * same breath.
 */
async function deleteAll(what: string, targets: [key: string, query: string][]): Promise<void> {
  const deleter = store();
  const refused: number[] = [];
  for (let from = 0; from < targets.length; from += AT_ONCE) {
    const answers = await Promise.all(
      targets.slice(from, from + AT_ONCE).map(([key, query]) => deleter.call("DELETE", key, query)),
    );
    refused.push(
      ...answers.filter((one) => !one.ok && one.status !== 404).map((one) => one.status),
    );
  }
  if (refused.length > 0) {
    throw new Error(
      `storage refused ${refused.length} of ${targets.length} ${what}: ${refused.join(", ")}`,
    );
  }
}
