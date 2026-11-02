import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { env } from "../src/auth/config.ts";
import { downloadTtlSeconds, partBytes, uploadTtlSeconds } from "../src/media/config.ts";
import {
  abortUploads,
  completeUpload,
  createUpload,
  deleteObjects,
  downloadUrl,
  headSize,
  partUrls,
  storageDriver,
} from "../src/media/r2.ts";
export async function checkStorage(prefix: string, say: (line: string) => void): Promise<void> {
  const key = `${prefix}/object`;
  const abandoned = `${prefix}/abandoned`;
  const started: {
    key: string;
    uploadId: string;
  }[] = [];
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      const result = await run();
      say(`ok    ${name}`);
      return result;
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : error}`, {
        cause: error,
      });
    }
  };
  const start = async (at: string) => {
    const uploadId = await createUpload(at);
    started.push({ key: at, uploadId });
    return uploadId;
  };
  const first = Buffer.alloc(partBytes(), 1);
  const last = Buffer.from("the last part may be short");
  try {
    const uploadId = await step("start a multipart upload", () => start(key));
    const [firstLink] = await partUrls(key, uploadId, 2, uploadTtlSeconds());
    const one = await step("send part 1 through its signed link", () => put(firstLink, first));
    const [, secondLink] = await partUrls(key, uploadId, 2, uploadTtlSeconds());
    const two = await step("send the missing part 2 through a re-issued link", () =>
      put(secondLink, last),
    );
    await step("complete it from parts reported out of order", () =>
      completeUpload(key, uploadId, [
        { part_number: 2, etag: two },
        { part_number: 1, etag: one },
      ]),
    );
    await step("measure it", async () =>
      assert.equal(await headSize(key), first.length + last.length),
    );
    await step("download it through a signed link", async () => {
      const got = await fetch(await downloadUrl(key, downloadTtlSeconds()));
      if (!got.ok) throw new Error(`answered ${got.status}: ${await got.text()}`);
      const bytes = Buffer.from(await got.arrayBuffer());
      assert.ok(bytes.equals(Buffer.concat([first, last])), "the bytes that came back differ");
    });
    const strayId = await step("start an upload to abandon", () => start(abandoned));
    const google = storageDriver() === "google";
    await step(`an expired part link answers ${google ? "400 ExpiredToken" : "403"}`, async () => {
      const [link] = await partUrls(abandoned, strayId, 1, 1);
      await sleep(3000);
      const got = await send(link, last);
      const body = await got.text();
      const expired = google
        ? got.status === 400 && body.includes("<Code>ExpiredToken</Code>")
        : got.status === 403;
      assert.ok(expired, `answered ${got.status}: ${body}`);
    });
    await step("abort it", () => abortUploads([{ key: abandoned, uploadId: strayId }]));
    await step("the aborted upload takes no more parts", async () => {
      const [link] = await partUrls(abandoned, strayId, 1, uploadTtlSeconds());
      const got = await send(link, last);
      assert.equal(got.status, 404, `answered ${got.status}: ${await got.text()}`);
    });
    await step("aborting it again is no error", () =>
      abortUploads([{ key: abandoned, uploadId: strayId }]),
    );
    await step("delete the object", () => deleteObjects([key]));
    await step("it is gone", async () => assert.equal(await headSize(key), null));
    await step("deleting it again is no error", () => deleteObjects([key]));
  } finally {
    const cleared = await Promise.allSettled([
      abortUploads(started),
      deleteObjects([key, abandoned]),
    ]);
    for (const one of cleared) {
      if (one.status === "rejected") say(`left behind under ${prefix}/: ${one.reason}`);
    }
  }
}
function send(link: string | undefined, bytes: Buffer): Promise<Response> {
  assert.ok(link, "no link was signed");
  return fetch(link, { method: "PUT", body: bytes });
}
async function put(link: string | undefined, bytes: Buffer): Promise<string> {
  const sent = await send(link, bytes);
  const etag = sent.headers.get("etag");
  assert.ok(sent.ok && etag, `answered ${sent.status}: ${await sent.text()}`);
  return etag;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const setting = (name: string) => env(`STORAGE_CHECK_${name}`);
  const withoutSlash = (path: string | undefined) => path?.trim().replace(/\/+$/, "");
  function stop(message: string): never {
    console.error(`error: ${message} (docs/running.md, «Живой контроль хранилища»)`);
    process.exit(1);
  }
  const run = randomUUID();
  let where: string;
  let prefix: string;
  if (setting("DRIVER")?.toLowerCase() === "google") {
    const bucket = setting("BUCKET");
    const checks = withoutSlash(setting("PREFIX"));
    const credentials = setting("CREDENTIALS");
    if (!bucket || !checks || !credentials) {
      stop("set STORAGE_CHECK_BUCKET, STORAGE_CHECK_PREFIX and STORAGE_CHECK_CREDENTIALS");
    }
    const product = withoutSlash(env("GOOGLE_STORAGE_PREFIX"));
    const within = (inner: string, outer: string) => `${inner}/`.startsWith(`${outer}/`);
    if (
      product &&
      bucket === env("GOOGLE_STORAGE_BUCKET") &&
      (within(checks, product) || within(product, checks))
    ) {
      stop(`${bucket}/${checks}/ overlaps ${product}/, the prefix GOOGLE_STORAGE_PREFIX names`);
    }
    Object.assign(process.env, {
      STORAGE_DRIVER: "google",
      GOOGLE_STORAGE_BUCKET: bucket,
      GOOGLE_STORAGE_PREFIX: checks,
      GOOGLE_STORAGE_CREDENTIALS: credentials,
    });
    prefix = run;
    where = `gs://${bucket}/${checks}/${run}/`;
  } else {
    const endpoint = withoutSlash(setting("ENDPOINT"));
    const bucket = setting("BUCKET");
    const accessKeyId = setting("ACCESS_KEY_ID");
    const secret = setting("SECRET_ACCESS_KEY");
    if (!endpoint || !bucket || !accessKeyId || !secret) {
      stop(
        "set STORAGE_CHECK_ENDPOINT, STORAGE_CHECK_BUCKET, STORAGE_CHECK_ACCESS_KEY_ID " +
          "and STORAGE_CHECK_SECRET_ACCESS_KEY",
      );
    }
    if (endpoint === withoutSlash(env("R2_ENDPOINT")) && bucket === env("R2_BUCKET")) {
      stop(`${endpoint}/${bucket} is the bucket R2_* names — the product's own`);
    }
    Object.assign(process.env, {
      STORAGE_DRIVER: "s3",
      R2_ENDPOINT: endpoint,
      R2_BUCKET: bucket,
      R2_ACCESS_KEY_ID: accessKeyId,
      R2_SECRET_ACCESS_KEY: secret,
      R2_REGION: setting("REGION") ?? "auto",
    });
    prefix = `${setting("PREFIX") ?? "storage-check"}/${run}`;
    where = `${endpoint}/${bucket}/${prefix}/`;
  }
  console.log(`info: checking ${where}`);
  try {
    await checkStorage(prefix, console.log);
    console.log("info: every call held");
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
