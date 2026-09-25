import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, signIn } from "../auth/testing.ts";
import { sql } from "../db.ts";
import { as, assembled, knock, material, order, underTag } from "./testing.ts";

/**
 * Стук воркера о готовом ролике: секрет, состояние строки и пуш, который из
 * этого выходит, — всем участникам и на языке каждого (`ready.ts`).
 */

const { email, createMemory, member, cleanup } = underTag("task53ready");

afterAll(cleanup);

test("the worker's knock needs the secret and tells the whole memory", async () => {
  const { app, lines } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  // In the memory and never notified: they registered no device.
  await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  await material(memory.id, organizer.user.id, 3);
  const montage = (await order(app, organizer.token, memory.id, {})).json();
  await assembled(montage.id);

  // Two of the three carry a phone; the contributor's silence is what proves
  // the notification goes by device and not by member.
  const devices = [`ExponentPushToken[${randomUUID()}]`, `ExponentPushToken[${randomUUID()}]`];
  for (const [index, token] of [organizer.token, viewer.token].entries()) {
    const registered = await app.inject(
      as(token, { method: "POST", url: "/me/push-tokens", payload: { token: devices[index] } }),
    );
    expect(registered.statusCode).toBe(200);
  }

  const previousToken = process.env.INTERNAL_WORKER_TOKEN;
  const previousPush = process.env.EXPO_PUSH_URL;
  try {
    // Unset means shut, not open: a caller with a plausible token gets the same
    // answer as one with none.
    delete process.env.INTERNAL_WORKER_TOKEN;
    for (const secret of [undefined, "s3cret", ""]) {
      const shut = await knock(app, montage.id, secret);
      expect(shut.statusCode).toBe(401);
      expect(shut.body).toBe('{"error":"unauthorized"}');
    }

    process.env.INTERNAL_WORKER_TOKEN = "s3cret";
    for (const secret of [undefined, "", "s3cre", "s3crett", "wrong"]) {
      expect((await knock(app, montage.id, secret)).statusCode).toBe(401);
    }

    // A row nobody has rendered yet. The secret is right, the id is real, and
    // the answer is still 404: this route only knows how to say «готов», so a
    // knock over a `queued` row must not light up the memory's phones.
    const unrendered = (await order(app, organizer.token, memory.id, {})).json();
    const early = await knock(app, unrendered.id, "s3cret");
    expect(early.statusCode).toBe(404);
    expect(early.body).toBe('{"error":"not found"}');

    // Pushing switched off, so what would have gone out is in the log — which
    // is also the whole of what a developer sees on a machine without push.
    process.env.EXPO_PUSH_URL = "";
    const told = await knock(app, montage.id, "s3cret");
    expect(told.statusCode).toBe(200);
    expect(told.json()).toEqual({ ok: true });

    const logged = lines
      .map(
        (l) =>
          JSON.parse(l) as {
            msg?: string;
            devices?: number;
            message?: { body: { ru: string; en: string }; data: unknown };
          },
      )
      .findLast((l) => l.msg === "montage push not sent");
    expect(logged?.message?.body?.ru).toContain(memory.title);
    expect(logged?.message?.body?.ru).toContain("готов");
    // Both languages are composed before anyone is picked out of the memory —
    // its members do not share one, so the send carries both (doc-8).
    expect(logged?.message?.body?.en).toContain(memory.title);
    expect(logged?.message?.body?.en).toContain("is ready");
    // Both ids: the app opens the memory's videos and puts this one on top.
    expect(logged?.message?.data).toEqual({ memoryId: memory.id, montageId: montage.id });
    // Two phones out of three members — everyone in the memory who has one, and
    // the person who ordered it is not the only one told (doc-03).
    expect(logged?.devices).toBe(2);

    // The scheme is case-insensitive here because it is everywhere else in the
    // service (RFC 7235, and clients do send it lowercase): the same header
    // must not open the session routes and get turned away by this one.
    const lowercase = await app.inject({
      method: "POST",
      url: `/internal/montages/${montage.id}/ready`,
      headers: { authorization: "bearer s3cret" },
    });
    expect(lowercase.statusCode).toBe(200);

    // A montage nobody has, and an id that is not one: the same 404 the rest of
    // the service gives, and no notification behind it.
    for (const id of [randomUUID(), "not-a-uuid"]) {
      const missing = await knock(app, id, "s3cret");
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toBe('{"error":"not found"}');
    }

    // And with somewhere to send it that nothing answers: the video is ready
    // whether or not a phone hears about it, so the worker is still told `ok`.
    process.env.EXPO_PUSH_URL = "http://127.0.0.1:1/push";
    const undelivered = await knock(app, montage.id, "s3cret");
    expect(undelivered.statusCode).toBe(200);
    expect(undelivered.json()).toEqual({ ok: true });
    expect(lines.some((l) => l.includes("montage push failed"))).toBe(true);
  } finally {
    if (previousToken === undefined) delete process.env.INTERNAL_WORKER_TOKEN;
    else process.env.INTERNAL_WORKER_TOKEN = previousToken;
    if (previousPush === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previousPush;
  }

  await sql`delete from push_tokens where token in ${sql(devices)}`;
  await app.close();
});

test("a memory with more devices than Expo takes at once is told in slices", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await material(memory.id, organizer.user.id, 3);
  const montage = (await order(app, organizer.token, memory.id, {})).json();
  await assembled(montage.id);

  // One over Expo's ceiling of 100 messages per request. Sent whole it would
  // come back 400 and nobody at all would hear about the video — the wedding
  // this product is for is exactly the size that trips it.
  const devices = Array.from({ length: 101 }, () => ({
    token: `ExponentPushToken[${randomUUID()}]`,
    user_id: organizer.user.id,
  }));
  await sql`insert into push_tokens ${sql(devices, "token", "user_id")}`;

  // Expo, stood in for, the way auth.test.ts stands in for the mailbox: a host of
  // its own, so nothing here needs a way out to the internet. It counts how
  // many messages each request carried.
  const batches: number[] = [];
  const expo = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      batches.push(JSON.parse(Buffer.concat(chunks).toString()).length);
      response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
    });
  });
  await new Promise<void>((resolve) => {
    expo.listen(0, "127.0.0.1", resolve);
  });

  const previousToken = process.env.INTERNAL_WORKER_TOKEN;
  const previousPush = process.env.EXPO_PUSH_URL;
  try {
    process.env.INTERNAL_WORKER_TOKEN = "s3cret";
    process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(expo.address() as AddressInfo).port}`;
    expect((await knock(app, montage.id, "s3cret")).statusCode).toBe(200);
  } finally {
    if (previousToken === undefined) delete process.env.INTERNAL_WORKER_TOKEN;
    else process.env.INTERNAL_WORKER_TOKEN = previousToken;
    if (previousPush === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previousPush;
    expo.close();
  }

  expect(batches).toEqual([100, 1]);

  await sql`delete from push_tokens where token in ${sql(devices.map((d) => d.token))}`;
  await app.close();
});

test("members who read different languages are each told in their own", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const guest = await member(app, memory.id, "viewer", organizer.user.id);
  await material(memory.id, organizer.user.id, 3);
  const montage = (await order(app, organizer.token, memory.id, {})).json();
  await assembled(montage.id);

  // The case a memory is full of and the invite path never sees: its members
  // are one person's guests, not one country's, so one send has to carry both
  // languages at once (doc-8). Each says which they read the way the app does,
  // then registers a phone.
  const russian = `ExponentPushToken[${randomUUID()}]`;
  const english = `ExponentPushToken[${randomUUID()}]`;
  for (const [who, language, device] of [
    [organizer, "ru", russian],
    [guest, "en", english],
  ] as const) {
    const chose = await app.inject(
      as(who.token, { method: "POST", url: "/me/language", payload: { language } }),
    );
    expect(chose.statusCode).toBe(200);
    const registered = await app.inject(
      as(who.token, { method: "POST", url: "/me/push-tokens", payload: { token: device } }),
    );
    expect(registered.statusCode).toBe(200);
  }

  // Expo stood in for, as above — this one keeps every message of every
  // request, so both who was told and what they were told are readable.
  const requests: { to: string; body: string }[][] = [];
  const expo = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
    });
  });
  await new Promise<void>((resolve) => {
    expo.listen(0, "127.0.0.1", resolve);
  });

  const previousToken = process.env.INTERNAL_WORKER_TOKEN;
  const previousPush = process.env.EXPO_PUSH_URL;
  try {
    process.env.INTERNAL_WORKER_TOKEN = "s3cret";
    process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(expo.address() as AddressInfo).port}`;
    expect((await knock(app, montage.id, "s3cret")).statusCode).toBe(200);
  } finally {
    if (previousToken === undefined) delete process.env.INTERNAL_WORKER_TOKEN;
    else process.env.INTERNAL_WORKER_TOKEN = previousToken;
    if (previousPush === undefined) delete process.env.EXPO_PUSH_URL;
    else process.env.EXPO_PUSH_URL = previousPush;
    expo.close();
  }

  // One request, not one per language: a message of Expo's array is whole in
  // itself, so two languages cost no extra round trip and the batching stays
  // where it was — one message per device.
  expect(requests.map((batch) => batch.length)).toEqual([2]);
  const told = new Map(requests.flat().map((message) => [message.to, message.body]));
  expect(told.get(russian)).toBe(`Ролик из «${memory.title}» готов — посмотрите и поделитесь`);
  expect(told.get(english)).toBe(
    `The movie from “${memory.title}” is ready — take a look and share it`,
  );

  await sql`delete from push_tokens where token in ${sql([russian, english])}`;
  await app.close();
});
