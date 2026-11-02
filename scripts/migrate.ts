import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Postgrator from "postgrator";
import { sql } from "../src/db.ts";

const postgrator = new Postgrator({
  driver: "pg",
  schemaTable: "schema_migrations",
  migrationPattern: fileURLToPath(new URL("../migrations/*", import.meta.url)),
  execQuery: (query) => sql.unsafe(query).then((rows) => ({ rows })),
  execSqlScript: (script) =>
    sql
      .unsafe(script)
      .simple()
      .then(() => undefined),
});
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
