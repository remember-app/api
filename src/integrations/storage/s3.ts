import { AwsClient } from "aws4fetch";
import { config } from "../../config.ts";

export type Store = {
  call(method: string, key: string, query?: string, init?: RequestInit): Promise<Response>;
  link(
    method: "GET" | "PUT",
    key: string,
    ttl: number,
    query?: Record<string, string>,
  ): Promise<string>;
};

export type UploadedPart = {
  part_number: number;
  etag: string;
};

export function storageConfigured(): boolean {
  return Boolean(
    config.s3.endpoint() &&
      config.s3.bucket() &&
      config.s3.accessKeyId() &&
      config.s3.secretAccessKey(),
  );
}
const store = (): Store => s3Store();
function s3Store(): Store {
  const aws = new AwsClient({
    accessKeyId: config.s3.accessKeyId() ?? "",
    secretAccessKey: config.s3.secretAccessKey() ?? "",
    service: "s3",
    region: config.s3.region(),
  });
  const url = (key: string, query = "") =>
    `${config.s3.endpoint()}/${config.s3.bucket()}/${key}${query && `?${query}`}`;
  const publicUrl = (key: string, query = "") =>
    `${config.s3.publicEndpoint()}/${config.s3.bucket()}/${key}${query && `?${query}`}`;
  return {
    call: (method, key, query, init) => aws.fetch(url(key, query), { ...init, method }),
    link: async (method, key, ttl, query = {}) => {
      const params = Object.entries(query).map(
        ([name, value]) => `${name}=${encodeURIComponent(value)}`,
      );
      const signed = await aws.sign(publicUrl(key, [...params, `X-Amz-Expires=${ttl}`].join("&")), {
        method,
        aws: { signQuery: true },
      });
      return signed.url;
    },
  };
}
export async function createUpload(key: string, contentType: string): Promise<string> {
  const response = await store().call("POST", key, "uploads", {
    headers: { "content-type": contentType },
  });
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
