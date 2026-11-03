import { AwsClient } from "aws4fetch";
import { env } from "../auth/config.ts";
import type { Store, UploadedPart } from "../types/media.ts";
import { googleStore } from "./gcs.ts";

export type { Store, UploadedPart };
export function storageDriver(): "s3" | "google" {
  const name = env("STORAGE_DRIVER")?.toLowerCase() ?? "s3";
  if (name === "s3" || name === "google") return name;
  throw new Error(`STORAGE_DRIVER is "${name}", and it can only be s3 or google`);
}
const endpoint = () => env("R2_ENDPOINT")?.replace(/\/+$/, "");
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
      const signed = await aws.sign(url(key, [...params, `X-Amz-Expires=${ttl}`].join("&")), {
        method,
        aws: { signQuery: true },
      });
      return signed.url;
    },
  };
}
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
    headers: { "content-type": "application/xml" },
    body: `<CompleteMultipartUpload>${xml}</CompleteMultipartUpload>`,
  });
  const body = await response.text();
  if (!response.ok || body.includes("<Error")) {
    throw new Error(`storage refused to complete the upload: ${response.status} ${body}`);
  }
}
export async function headSize(key: string): Promise<number | null> {
  const response = await store().call("HEAD", key);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`storage refused a HEAD: ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) ? length : null;
}
export const downloadUrl = (key: string, ttlSeconds: number): Promise<string> =>
  store().link("GET", key, ttlSeconds);
export const abortUploads = (
  uploads: {
    key: string;
    uploadId: string;
  }[],
) =>
  deleteAll(
    "aborts",
    uploads.map(({ key, uploadId }) => [key, `uploadId=${encodeURIComponent(uploadId)}`]),
  );
export const deleteObjects = (keys: string[]) =>
  deleteAll(
    "deletes",
    keys.map((key) => [key, ""]),
  );
const AT_ONCE = 32;
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
