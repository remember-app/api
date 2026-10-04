import { afterAll, expect, test } from "vitest";
import { sql } from "./db.ts";

/**
 * The suite must never talk to the database the stand runs on. That database
 * has a live worker on it, taking the jobs these tests write and marking them
 * `running`, so a test waiting for `queued` finds `running` instead — a red
 * that comes and goes with the worker's timing rather than with any change in
 * the code. `scripts/test.ts` puts every run on the stand's database with
 * `_test` on the end; this is what notices if that ever stops happening.
 *
 * Asked of the database itself rather than of the environment, so it is the
 * connection actually in use that answers, not the variable that was set.
 */

afterAll(async () => {
  await sql.end();
});

test("the suite runs against the test database, not the stand's", async () => {
  const [row] = await sql<{ name: string }[]>`select current_database() as name`;
  expect(row?.name).toMatch(/_test$/);
});
