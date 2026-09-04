import { AwsClient } from "aws4fetch";

/**
 * The object store: Cloudflare R2 in production, MinIO from `docker-compose`
 * locally. One code path for both — R2 speaks S3, and both address a bucket by
 * path (`<endpoint>/<bucket>/<key>`) rather than by hostname.
 *
 * `aws4fetch` and not `@aws-sdk/client-s3`: the whole of what is needed here is
 * SigV4 and four requests, which that is 80 KB and no transitive dependencies
 * for. The XML is read with a regex for the same reason — one tag out of one
 * response is not a parser.
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
 * R2 ignores the region and wants the literal `auto`; MinIO signs with
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
  if (!response.ok) throw new Error(`R2 refused a multipart upload: ${response.status} ${body}`);
  const uploadId = body.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error(`R2 started an upload without an id: ${body}`);
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
      body: `<CompleteMultipartUpload>${xml}</CompleteMultipartUpload>`,
    },
  );
  const body = await response.text();
  // S3 may answer 200 and then put the failure in the body — it keeps the
  // connection warm while it assembles, so the status is written before the
  // outcome is known.
  if (!response.ok || body.includes("<Error")) {
    throw new Error(`R2 refused to complete the upload: ${response.status} ${body}`);
  }
}

/** What R2 actually holds, in bytes — or null if there is no such object. */
export async function headSize(key: string): Promise<number | null> {
  const response = await client().fetch(objectUrl(key), { method: "HEAD" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`R2 refused a HEAD: ${response.status}`);
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
 *
 * `NoSuchUpload` is not a failure, for the reason a missing key is not one
 * below: an upload aborted twice, or one that completed after all, is already
 * the outcome this wanted.
 */
export async function abortUploads(uploads: { key: string; uploadId: string }[]): Promise<void> {
  const aws = client();
  const answers = await Promise.all(
    uploads.map(({ key, uploadId }) =>
      aws.fetch(`${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" }),
    ),
  );
  const refused = answers.filter((answer) => !answer.ok && answer.status !== 404);
  if (refused.length > 0) {
    throw new Error(
      `R2 refused ${refused.length} of ${uploads.length} aborts: ` +
        refused.map((answer) => answer.status).join(", "),
    );
  }
}

/**
 * Drops objects by key. A key that is not there is **not** a failure: a record
 * may well be deleted before the worker has made its preview, and a missing
 * derivative must not stop the original from going — S3 answers a delete of
 * nothing with 204 anyway.
 *
 * ponytail: one request per key instead of S3's multi-object delete. That call
 * brings an XML body, a Content-MD5 header and an error shape of its own, to
 * save round trips nobody is counting — one departure on this pilot is tens of
 * files. Swap it in if a departure ever means thousands.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  const aws = client();
  const answers = await Promise.all(
    keys.map((key) => aws.fetch(objectUrl(key), { method: "DELETE" })),
  );
  const refused = answers.filter((answer) => !answer.ok && answer.status !== 404);
  if (refused.length > 0) {
    throw new Error(
      `R2 refused ${refused.length} of ${keys.length} deletes: ` +
        refused.map((answer) => answer.status).join(", "),
    );
  }
}
