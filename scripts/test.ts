import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * The database this run of the suite talks to. Never the stand's, and never
 * another run's.
 *
 * Never the stand's: a live worker takes the jobs these tests write and marks
 * them running, so a test waiting for `queued` finds `running` instead — red,
 * and red only on the runs where the worker got there first.
 *
 * Never another run's: two suites started at once — two worktrees, two sessions
 * — used to land on one `_test` database and read each other's rows, the same
 * flapping red between two runs that TASK-536 fixed between a run and the stand.
 * So the name carries a tag drawn for this run alone, and no two runs can share
 * one. It still ends in `_test`, the mark `src/db.test.ts` checks.
 *
 * The name is the stand's — or `TEST_DATABASE_URL`, which chooses the base when
 * it is set — with the run's tag and `_test` on the end, so one `DATABASE_URL`
 * still moves the stand and every test database with it.
 */
const stand = process.env.DATABASE_URL;
if (!stand) throw new Error("DATABASE_URL is not set — see docs/running.md");

const tag = randomBytes(4).toString("hex");
const test = new URL(process.env.TEST_DATABASE_URL ?? stand);
// A name someone already marked `_test` takes the tag in the same place, before
// that mark, so `remember` and `remember_test` name the same run's database.
test.pathname = `${test.pathname.replace(/_test$/, "")}_${tag}_test`;
const url = test.toString();
const name = test.pathname.slice(1);

// A database of its own has to exist before anything can migrate into it. The
// server's own `postgres` database answers even when nothing else is up, so the
// stand is never what this hangs off.
const server = new URL(url);
server.pathname = "/postgres";
const sql = postgres(server.toString(), { max: 1, onnotice: () => {} });
await sql`create database ${sql(name)}`;
console.log(`created database ${name}`);

/** Migrations and the suite itself, both on that one database. */
const env = { ...process.env, DATABASE_URL: url, TEST_DB_TAG: tag };
const run = (args: string[]) => spawnSync(process.execPath, args, { env, stdio: "inherit" });

const migrated = run(["scripts/migrate.ts"]);

// Whatever `npm test -- …` was given goes to the runner, so pointing at one file
// still works.
const tested =
  migrated.status === 0
    ? run(["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)])
    : null;

// Nobody else's database, and none left behind for the next run: dropped here,
// whatever the suite said.
await sql`drop database if exists ${sql(name)} with (force)`;
await sql.end();

process.exit((tested ?? migrated).status ?? 1);
