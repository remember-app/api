import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, signIn } from "../auth/testing.ts";
import { sql } from "../db.ts";
import { as, underTag } from "../montages/testing.ts";

/**
 * `POST /memories/:memoryId/analyze` — отсев по требованию (`screening.ts`).
 * Что спрашивается: кто вправе его запустить, что в очередь встаёт ровно одна
 * задача `media_analysis` со ссылкой на воспоминание, и что повторный вызов
 * второй не плодит.
 */

const { email, createMemory, member, cleanup } = underTag("task589");

afterAll(cleanup);

type App = ReturnType<typeof buildTestApp>["app"];

const analyze = (app: App, token: string, memoryId: string) =>
  app.inject(as(token, { method: "POST", url: `/memories/${memoryId}/analyze` }));

const jobsOf = (memoryId: string) =>
  sql<{ type: string; status: string }[]>`
    select type, status from jobs where ref = ${memoryId} order by id
  `;

/** What the worker would have done to the job while a person waits. */
const markJob = (memoryId: string, status: "running" | "done" | "failed") =>
  sql`update jobs set status = ${status} where type = 'media_analysis' and ref = ${memoryId}`;

test("the organizer's Analyze queues one media_analysis job for the memory", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  const reply = await analyze(app, organizer.token, memory.id);
  expect(reply.statusCode).toBe(202);
  expect(reply.json()).toEqual({ status: "queued" });
  expect(await jobsOf(memory.id)).toEqual([{ type: "media_analysis", status: "queued" }]);
});

test("anybody but the organizer is refused and the queue stays empty", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  const contributor = await member(app, memory.id, "contributor", organizer.user.id);
  const viewer = await member(app, memory.id, "viewer", organizer.user.id);
  const stranger = await signIn(app, email());

  for (const token of [contributor.token, viewer.token]) {
    const refused = await analyze(app, token, memory.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "forbidden" });
  }
  // A stranger never reaches the route at all: the membership check answers
  // the house 404, before a word about the queue is said.
  expect((await analyze(app, stranger.token, memory.id)).statusCode).toBe(404);

  // Nor does anybody who names a memory that is not there — an id nobody has,
  // or one that is not even a uuid. The organizer is no exception.
  const nowhere = randomUUID();
  expect((await analyze(app, organizer.token, nowhere)).statusCode).toBe(404);
  expect((await analyze(app, stranger.token, nowhere)).statusCode).toBe(404);
  expect((await analyze(app, organizer.token, "not-a-uuid")).statusCode).toBe(404);
  expect(await jobsOf(nowhere)).toEqual([]);
  expect(await jobsOf(memory.id)).toEqual([]);
});

test("a second tap neither adds a job nor pretends the analysis restarted", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  expect((await analyze(app, organizer.token, memory.id)).json()).toEqual({ status: "queued" });
  const again = await analyze(app, organizer.token, memory.id);
  expect(again.statusCode).toBe(202);
  expect(again.json()).toEqual({ status: "queued" });
  expect(await jobsOf(memory.id)).toHaveLength(1);

  await markJob(memory.id, "running");
  const whileRunning = await analyze(app, organizer.token, memory.id);
  expect(whileRunning.statusCode).toBe(202);
  expect(whileRunning.json()).toEqual({ status: "running" });
  expect(await jobsOf(memory.id)).toEqual([{ type: "media_analysis", status: "running" }]);
});

test("a tap waits on the per-memory queue lock before it looks", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  // Somebody else holds the memory's queue lock, as a tap in flight would.
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  let acquire = () => {};
  const acquired = new Promise<void>((done) => {
    acquire = done;
  });
  const holder = sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`media_analysis:${memory.id}`}))`;
    acquire();
    await held;
  });
  await acquired;

  const reply = analyze(app, organizer.token, memory.id);
  // Long enough for the tap to have run both of its queries had nothing held
  // it: the lock is the only thing keeping two taps from queueing twice.
  await new Promise((done) => setTimeout(done, 500));
  expect(await jobsOf(memory.id)).toEqual([]);

  release();
  await holder;
  expect((await reply).statusCode).toBe(202);
  expect(await jobsOf(memory.id)).toEqual([{ type: "media_analysis", status: "queued" }]);
});

test("two taps at once queue one job, and both answer 202", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);

  const replies = await Promise.all(
    Array.from({ length: 8 }, () => analyze(app, organizer.token, memory.id)),
  );
  for (const reply of replies) {
    expect(reply.statusCode).toBe(202);
    expect(["queued", "running"]).toContain(reply.json().status);
  }
  expect(await jobsOf(memory.id)).toEqual([{ type: "media_analysis", status: "queued" }]);
});

test("a tap racing the worker finishing the job answers 202, not 500", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());
  const memory = await createMemory(app, organizer.token);
  await analyze(app, organizer.token, memory.id); // a job waiting in the queue

  // Waiting jobs — the index the check reads is the one they fill, so the check
  // takes long enough for the worker's finish to land inside it, in the window
  // the two-query version answered 500 from. No memory is named by them, so no
  // other read sees anything.
  const filler = `filler-${randomUUID()}`;
  await sql`
    insert into jobs (type, ref, status)
    select 'filler', ${filler}, 'queued' from generate_series(1, 300000)
  `;

  // The worker: it takes the waiting job and finishes it, but has not
  // committed while the tap is looking.
  let finish = () => {};
  const finished = new Promise<void>((done) => {
    finish = done;
  });
  const worker = sql.begin(async (tx) => {
    await tx`
      update jobs set status = 'done'
      where type = 'media_analysis' and ref = ${memory.id}
    `;
    await finished;
  });

  const reply = analyze(app, organizer.token, memory.id);
  // Once the tap's own statement against `jobs` is running — not merely the
  // tap begun — the worker finishes. The tap must answer from the queue it
  // saw when that statement started, as one statement does.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [busy] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where state = 'active' and pid <> pg_backend_pid()
        and query like '%media_analysis%'
    `;
    if ((busy?.n ?? 0) > 0) break;
    await new Promise((done) => setTimeout(done, 1));
  }
  // Seen active is not yet seen with a snapshot taken — let the scan start.
  await new Promise((done) => setTimeout(done, 3));
  finish();
  await worker;

  const answered = await reply;
  expect(answered.statusCode).toBe(202);
  expect(answered.json()).toEqual({ status: "queued" });

  await sql`delete from jobs where type = 'filler' and ref = ${filler}`;
});

test("a finished or failed analysis does not block the next tap", async () => {
  const { app } = buildTestApp();
  const organizer = await signIn(app, email());

  for (const ended of ["done", "failed"] as const) {
    const memory = await createMemory(app, organizer.token);
    await analyze(app, organizer.token, memory.id);
    await markJob(memory.id, ended);

    const again = await analyze(app, organizer.token, memory.id);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ status: "queued" });
    expect(await jobsOf(memory.id)).toEqual([
      { type: "media_analysis", status: ended },
      { type: "media_analysis", status: "queued" },
    ]);
  }
});
