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

try {
  const applied = await postgrator.migrate();
  console.log(
    applied.length > 0
      ? `applied: ${applied.map((m) => `${m.version} ${m.name}`).join(", ")}`
      : "already up to date",
  );
} finally {
  await sql.end();
}
