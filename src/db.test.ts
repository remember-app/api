import { afterAll, expect, test } from "vitest";
import { sql } from "./db.ts";

/**
 * The suite must never talk to the database the stand runs on, and never to one
 * another run is using. The stand's has a live worker on it, taking the jobs
 * these tests write and marking them `running`, so a test waiting for `queued`
 * finds `running` instead — a red that comes and goes with the worker's timing
 * rather than with any change in the code. A database two runs share turns the
 * same trick on the runs themselves: each reads rows the other wrote, the queue
 * counts one too many, and the number of reds moves about with who got there
 * first.
 *
 * `scripts/test.ts` puts every run on the stand's database with a tag of the
 * run's own and `_test` on the end; this is what notices if either ever stops
 * happening — the tag gone means two runs would land on one database again.
 *
 * Asked of the database itself rather than of the environment, so it is the
 * connection actually in use that answers, not the variable that was set.
 */

afterAll(async () => {
  await sql.end();
});

test("the suite runs against a test database of its own", async () => {
  const [row] = await sql<{ name: string }[]>`select current_database() as name`;
  const name = row?.name ?? "";
  // The stand's database, with no `_test` on the end.
  expect(name).toMatch(/_test$/);
  // A database two runs would share, with no tag of this run's.
  expect(name).toMatch(new RegExp(`_${process.env.TEST_DB_TAG}_test$`));
});
