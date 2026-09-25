import { AwsClient } from "aws4fetch";

/**
 * The object store: Google Cloud Storage through its S3-compatible XML API in
 * production, MinIO from `docker-compose` locally, Cloudflare R2 before that —
 * whence the name, kept with the `R2_*` variables the stands already read. One
 * code path for all three: every request is in the form all of them accept, and
 * all of them address a bucket by path (`<endpoint>/<bucket>/<key>`). What was
 * checked against Google and how it is held in place: docs/media.md,
 * «Хранилище: Google Cloud Storage», and `r2.test.ts`.
 *
 * `aws4fetch` and not `@aws-sdk/client-s3`: the whole of what is needed here is
 * SigV4 and four requests, which that is 80 KB and no transitive dependencies
 * for. It is also why no checksum headers go out — the SDK adds
 * `x-amz-checksum-*` by default, and Google answers those with
 * `SignatureDoesNotMatch`. The XML is read with a regex for the same reason —
 * one tag out of one response is not a parser.
 */

const env = (name: string) => process.env[name]?.trim() || undefined;

/** Trailing slashes trimmed: `…:9000/` + `/bucket` is a path with an empty segment. */
const endpoint = () => env("R2_ENDPOINT")?.replace(/\/+$/, "");

/**
 * Nothing is presigned or uploaded until all four are set. A blank endpoint or
 * key is the same misconfiguration as a missing one, so the routes say so
 * plainly instead of answering as though the caller's request were at fault —
 * the same call `/auth/apple` makes when its client id is absent.
 */
export const storageConfigured = () =>
  Boolean(endpoint() && env("R2_BUCKET") && env("R2_ACCESS_KEY_ID") && env("R2_SECRET_ACCESS_KEY"));

/**
 * R2 wants the literal `auto`, Google takes any value at all, MinIO signs with
 * `us-east-1` unless told otherwise. It is a knob because those disagree.
 */
const client = () =>
  new AwsClient({
    accessKeyId: env("R2_ACCESS_KEY_ID") ?? "",
    secretAccessKey: env("R2_SECRET_ACCESS_KEY") ?? "",
    service: "s3",
    region: env("R2_REGION") ?? "auto",
  });

const objectUrl = (key: string) => `${endpoint()}/${env("R2_BUCKET")}/${key}`;

/** Starts a multipart upload and answers with its id. */
export async function createUpload(key: string): Promise<string> {
  const response = await client().fetch(`${objectUrl(key)}?uploads`, { method: "POST" });
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
  const aws = client();
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const url = `${objectUrl(key)}?partNumber=${index + 1}&uploadId=${encodeURIComponent(
        uploadId,
      )}&X-Amz-Expires=${ttlSeconds}`;
      // signQuery puts the signature in the query string, which is what makes
      // the link usable by a phone that holds no credentials.
      const signed = await aws.sign(url, { method: "PUT", aws: { signQuery: true } });
      return signed.url;
    }),
  );
}

/** The parts as the client reports them back: the number it sent and R2's receipt. */
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
  const response = await client().fetch(
    `${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`,
    {
      method: "POST",
      // Said outright: a string body goes out as `text/plain` otherwise, and
      // Google's reference says this request's body type is `application/xml`.
      headers: { "content-type": "application/xml" },
      body: `<CompleteMultipartUpload>${xml}</CompleteMultipartUpload>`,
    },
  );
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
  const response = await client().fetch(objectUrl(key), { method: "HEAD" });
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
export async function downloadUrl(key: string, ttlSeconds: number): Promise<string> {
  const signed = await client().sign(`${objectUrl(key)}?X-Amz-Expires=${ttlSeconds}`, {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}

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
    uploads.map(
      ({ key, uploadId }) => `${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`,
    ),
  );

/**
 * Drops objects by key.
 *
 * ponytail: one request per key instead of S3's multi-object delete. That call
 * brings an XML body, a Content-MD5 header and an error shape of its own, to
 * save round trips nobody is counting. Swap it in if the slices below stop
 * being enough.
 */
export const deleteObjects = (keys: string[]) => deleteAll("deletes", keys.map(objectUrl));

/** How many of those requests are in the air at once — see `deleteAll`. */
const AT_ONCE = 32;

/**
 * A `DELETE` on every one of them, and one account of what the bucket refused.
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
async function deleteAll(what: string, urls: string[]): Promise<void> {
  const aws = client();
  const refused: number[] = [];
  for (let from = 0; from < urls.length; from += AT_ONCE) {
    const answers = await Promise.all(
      urls.slice(from, from + AT_ONCE).map((url) => aws.fetch(url, { method: "DELETE" })),
    );
    refused.push(
      ...answers.filter((one) => !one.ok && one.status !== 404).map((one) => one.status),
    );
  }
  if (refused.length > 0) {
    throw new Error(
      `storage refused ${refused.length} of ${urls.length} ${what}: ${refused.join(", ")}`,
    );
  }
}
