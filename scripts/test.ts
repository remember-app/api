import { spawnSync } from "node:child_process";
import postgres from "postgres";

/**
 * The database the suite talks to. Never the stand's: a live worker takes the
 * jobs these tests write and marks them running, so a test waiting for `queued`
 * finds `running` instead — red, and red only on the runs where the worker got
 * there first.
 *
 * The name is the stand's with `_test` on the end, the same rule the root
 * Makefile uses for the worker's tests, so one `DATABASE_URL` moves the stand
 * and every test database with it. `TEST_DATABASE_URL`, when it is set, wins
 * outright.
 */
const stand = process.env.DATABASE_URL;
if (!stand) throw new Error("DATABASE_URL is not set — see docs/running.md");

const test = new URL(process.env.TEST_DATABASE_URL ?? stand);
if (!process.env.TEST_DATABASE_URL) test.pathname = `${test.pathname}_test`;
const url = test.toString();
const name = test.pathname.slice(1);

// A database of its own has to exist before anything can migrate into it. The
// server's own `postgres` database answers even when nothing else is up, so the
// stand is never what this hangs off.
const server = new URL(url);
server.pathname = "/postgres";
const sql = postgres(server.toString(), { max: 1, onnotice: () => {} });
if (!(await sql`select 1 from pg_database where datname = ${name}`)[0]) {
  await sql`create database ${sql(name)}`;
  console.log(`created database ${name}`);
}
await sql.end();

/** Migrations and the suite itself, both on that one database. */
const env = { ...process.env, DATABASE_URL: url };
const run = (args: string[]) => spawnSync(process.execPath, args, { env, stdio: "inherit" });

const migrated = run(["scripts/migrate.ts"]);
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

// Whatever `npm test -- …` was given goes to the runner, so pointing at one file
// still works.
const tested = run(["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)]);
process.exit(tested.status ?? 1);
