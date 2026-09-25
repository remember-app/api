import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "./app.ts";
import { generateCode } from "./auth/email.ts";
import { sql } from "./db.ts";
import { headSize } from "./media/r2.ts";

/**
 * The whole life of a photo, through a real listening server and real HTTP, from
 * the letter with the code to the memory's deletion. Every step has its own
 * tests elsewhere; what only this one catches is the steps not fitting together
 * — the session a sign-in minted opening the memory it made, the links the
 * server signed being ones the store honours, the delete leaving nothing behind.
 *
 * Twice, by the two ways a person gets in: the letter (an SMTP server of this
 * file's own, as in auth/auth.test.ts) and the reviewer's door, in production
 * mode with no mail at all — Apple's reviewer must be able to do all of it.
 */

const tag = "journey";
const mail = { user: "remember@example.com", password: `smtp-${randomUUID()}` };
const letters: { to: string[]; text: string }[] = [];

const smtp = new SMTPServer({
  onAuth({ username, password }, _session, done) {
    if (username === mail.user && password === mail.password) done(null, { user: username });
    else done(new Error("Invalid username or password"));
  },
  onData(stream, session, done) {
    simpleParser(stream)
      .then((parsed) => {
        letters.push({
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          text: parsed.text ?? "",
        });
      })
      .then(() => done(), done);
  },
});

const reviewer = { email: `${tag}-test-${randomUUID()}@example.com`, code: generateCode() };

let app: ReturnType<typeof buildApp>;
let base = "";

/** One part is the S3 floor (5 MiB) for every part but the last, so this is two parts. */
const partBytes = 5 * 1024 ** 2;
const photoBytes = Buffer.alloc(partBytes + 1000, 7);

beforeAll(async () => {
  // The test server's certificate is nobody's; the service itself never sets this.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  await new Promise<void>((resolve) => {
    smtp.listen(0, "127.0.0.1", resolve);
  });
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String((smtp.server.address() as AddressInfo).port),
    SMTP_SECURE: "false",
    SMTP_USER: mail.user,
    SMTP_PASSWORD: mail.password,
    MAIL_FROM: "Remember <no-reply@example.com>",
    MEDIA_UPLOAD_PART_BYTES: String(partBytes),
  });
  // Production's own locks: no development door, and the reviewer's one open.
  delete process.env.EMAIL_LOGIN_DEV_BYPASS;
  process.env.NODE_ENV = "production";
  process.env.REVIEW_LOGIN = `${reviewer.email}:${reviewer.code}`;
  app = buildApp({ logger: false });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => {
    smtp.close(() => resolve());
  });
  await sql`
    delete from jobs where ref in (
      select id::text from media_items where memory_id in (
        select id from memories where title like ${`${tag}-test %`}
      )
    )
  `;
  await sql`delete from memories where title like ${`${tag}-test %`}`;
  await sql`delete from users where email like ${`${tag}-test-%`}`;
  await sql.end();
});

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

/** By the letter: the code is read out of the mail the SMTP server received. */
async function viaLetter(email: string) {
  const posted = letters.length;
  expect((await call("POST", "/auth/email/start", undefined, { email })).status).toBe(200);
  expect(letters).toHaveLength(posted + 1);
  expect(letters.at(-1)?.to).toEqual([email]);
  const code = letters.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeDefined();
  return call("POST", "/auth/email/verify", undefined, { email, code });
}

/** By the reviewer's door: the fixed code, and no letter at all. */
async function viaReviewDoor() {
  const posted = letters.length;
  const started = await call("POST", "/auth/email/start", undefined, { email: reviewer.email });
  expect(started).toEqual({ status: 200, body: { ok: true } });
  const verified = await call("POST", "/auth/email/verify", undefined, {
    email: reviewer.email,
    code: reviewer.code,
  });
  expect(letters).toHaveLength(posted);
  return verified;
}

const putBytes = async (url: string, bytes: Buffer) => {
  const sent = await fetch(url, { method: "PUT", body: bytes });
  expect(sent.status).toBe(200);
  return sent.headers.get("etag") ?? "";
};

const sha = (bytes: Buffer | ArrayBuffer) =>
  createHash("sha256")
    .update(Buffer.from(bytes as ArrayBuffer))
    .digest("hex");

test.each(["the letter", "the reviewer's door"])(
  "a person signs in by %s, brings a photo in two parts, sees it, and takes it all down",
  async (way) => {
    const email = way === "the letter" ? `${tag}-test-${randomUUID()}@example.com` : reviewer.email;
    const signIn = () => (way === "the letter" ? viaLetter(email) : viaReviewDoor());
    const signed = await signIn();
    expect(signed.status).toBe(200);
    const { token, user } = signed.body as { token: string; user: { id: string } };
    expect((await call("GET", "/me", token)).body.id).toBe(user.id);

    // Registering: the agreement first, then a name.
    expect((await call("POST", "/me/consent", token)).status).toBe(200);
    const username = `j${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    expect((await call("POST", "/me/username", token, { username })).status).toBe(200);

    const created = await call("POST", "/memories", token, {
      title: `${tag}-test ${randomUUID()}`,
      event_start: "2026-09-02T18:00:00+03:00",
    });
    expect(created.status).toBe(201);
    const memoryId = created.body.id as string;
    expect((await call("GET", "/memories", token)).body.map((m: { id: string }) => m.id)).toContain(
      memoryId,
    );

    // A file of two parts: the first goes up, then its link is treated as lost.
    const intent = await call("POST", `/memories/${memoryId}/media`, token, {
      kind: "photo",
      size_bytes: photoBytes.length,
      captured_at: "2026-09-02T19:30:00+03:00",
    });
    expect(intent.status).toBe(201);
    const { id: mediaId, upload } = intent.body;
    expect(upload.parts).toHaveLength(2);
    const etag1 = await putBytes(upload.parts[0].url, photoBytes.subarray(0, partBytes));

    // Not in the gallery while in flight.
    expect((await call("GET", `/memories/${memoryId}/media`, token)).body).toEqual([]);

    // «Докачка»: the link asked for again names the same upload, and the missing
    // part goes up on the fresh link; the part already sent survived.
    const again = await call("GET", `/memories/${memoryId}/media/${mediaId}/upload`, token);
    expect(again.status).toBe(200);
    expect(again.body.upload.upload_id).toBe(upload.upload_id);
    expect(again.body.upload.parts).toHaveLength(2);
    const etag2 = await putBytes(again.body.upload.parts[1].url, photoBytes.subarray(partBytes));

    const done = await call("POST", `/memories/${memoryId}/media/${mediaId}/complete`, token, {
      parts: [
        { part_number: 1, etag: etag1 },
        { part_number: 2, etag: etag2 },
      ],
    });
    expect(done).toEqual({
      status: 200,
      body: { id: mediaId, status: "processing", first_upload: true },
    });
    expect(await headSize(`originals/${mediaId}`)).toBe(photoBytes.length);

    const gallery = await call("GET", `/memories/${memoryId}/media`, token);
    expect(gallery.body).toHaveLength(1);
    expect(gallery.body[0]).toMatchObject({ id: mediaId, kind: "photo", uploaded_by: user.id });
    const card = (await call("GET", "/memories", token)).body.find(
      (m: { id: string }) => m.id === memoryId,
    );
    expect(card.media_count).toBe(1);

    // The original comes back byte for byte through its signed link.
    const link = await call("GET", `/memories/${memoryId}/media/${mediaId}/download`, token);
    const original = await fetch(link.body.url);
    expect(original.status).toBe(200);
    expect(sha(await original.arrayBuffer())).toBe(sha(photoBytes));

    // A frame goes: the bytes leave the store and the counters go back to nothing.
    expect((await call("DELETE", `/memories/${memoryId}/media/${mediaId}`, token)).status).toBe(
      200,
    );
    expect(await headSize(`originals/${mediaId}`)).toBeNull();
    expect((await call("GET", `/memories/${memoryId}/media`, token)).body).toEqual([]);
    const [counters] =
      await sql`select media_count, storage_bytes from memories where id = ${memoryId}`;
    expect(counters).toEqual({ media_count: 0, storage_bytes: "0" });

    // A second frame is left in the memory when the memory itself is deleted: it
    // takes the row, the object and the queued preview with it.
    const second = await call("POST", `/memories/${memoryId}/media`, token, {
      kind: "photo",
      size_bytes: 512,
    });
    const secondEtag = await putBytes(second.body.upload.parts[0].url, Buffer.alloc(512, 1));
    await call("POST", `/memories/${memoryId}/media/${second.body.id}/complete`, token, {
      parts: [{ part_number: 1, etag: secondEtag }],
    });
    expect(await headSize(`originals/${second.body.id}`)).toBe(512);

    expect((await call("DELETE", `/memories/${memoryId}`, token)).status).toBe(200);
    expect(await headSize(`originals/${second.body.id}`)).toBeNull();
    expect((await call("GET", `/memories/${memoryId}/media`, token)).status).toBe(404);
    expect((await call("DELETE", `/memories/${memoryId}`, token)).status).toBe(404);
    const [left] = await sql`
    select (select count(*)::int from media_items where memory_id = ${memoryId}) as media,
           (select count(*)::int from memory_members where memory_id = ${memoryId}) as members,
           (select count(*)::int from jobs where ref = ${second.body.id}) as jobs
  `;
    expect(left).toEqual({ media: 0, members: 0, jobs: 0 });

    // Sessions: a second sign-in is a second session; one revokes the other, then
    // logs itself out, and a dead token is a plain 401.
    const other = await signIn();
    expect(other.status).toBe(200);
    const second_token = other.body.token as string;
    const listed = (await call("GET", "/auth/sessions", second_token)).body as {
      id: string;
      current: boolean;
    }[];
    expect(listed).toHaveLength(2);
    const first = listed.find((s) => !s.current);
    expect((await call("POST", `/auth/sessions/${first?.id}/revoke`, second_token)).status).toBe(
      200,
    );
    expect((await call("GET", "/me", token)).status).toBe(401);
    expect((await call("POST", "/auth/logout", second_token)).status).toBe(200);
    expect((await call("GET", "/me", second_token)).status).toBe(401);
  },
);
