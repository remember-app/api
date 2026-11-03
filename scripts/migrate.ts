import { fileURLToPath } from "node:url";
import Postgrator from "postgrator";
import { sql } from "../src/integrations/db/index.ts";

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
