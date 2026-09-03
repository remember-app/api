import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Postgrator from "postgrator";
import { sql } from "../src/db.ts";

const postgrator = new Postgrator({
  driver: "pg",
  schemaTable: "schema_migrations",
  migrationPattern: fileURLToPath(new URL("../migrations/*", import.meta.url)),
  // postgrator ships no driver of its own — these two hooks are the whole wiring.
  execQuery: (query) => sql.unsafe(query).then((rows) => ({ rows })),
  // Migration files may hold several statements, which needs the simple protocol.
  execSqlScript: (script) =>
    sql
      .unsafe(script)
      .simple()
      .then(() => undefined),
});

/**
 * The queue table api writes into but does not own: `jobs` belongs to montage
 * (`schema.sql`, `python worker.py init`). Its file is applied here, never
 * copied into a migration — that keeps montage the single source of its shape
 * while a local database (and `npm test`) still has the table. The file is
 * idempotent by design, so running this again changes nothing.
 *
 * The path is a knob because the neighbour is a sibling checkout: absent, as in
 * an api repository cloned on its own, the table is simply left to montage.
 */
const jobsSchema = process.env.MONTAGE_SCHEMA_SQL
  ? resolve(process.env.MONTAGE_SCHEMA_SQL)
  : fileURLToPath(new URL("../../montage/schema.sql", import.meta.url));

try {
  const applied = await postgrator.migrate();
  console.log(
    applied.length > 0
      ? `applied: ${applied.map((m) => `${m.version} ${m.name}`).join(", ")}`
      : "already up to date",
  );

  if (existsSync(jobsSchema)) {
    // Quietened first: this file is replayed on every run, and its
    // CREATE … IF NOT EXISTS lines otherwise print a NOTICE apiece before
    // every single test run.
    await sql
      .unsafe(`set client_min_messages = warning;\n${readFileSync(jobsSchema, "utf8")}`)
      .simple();
    console.log(`jobs table: applied ${jobsSchema} (owned by montage)`);
  } else {
    console.log(
      `jobs table: ${jobsSchema} not found — it belongs to montage. Clone the product ` +
        "repository with its submodules, or point MONTAGE_SCHEMA_SQL at that file.",
    );
  }
} finally {
  await sql.end();
}
