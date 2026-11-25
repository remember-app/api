import { fileURLToPath, pathToFileURL } from "node:url";
import Postgrator from "postgrator";
import { sql } from "../../../src/integrations/db/index.ts";

export async function migrate(): Promise<void> {
  const postgrator = new Postgrator({
    driver: "pg",
    schemaTable: "schema_migrations",
    migrationPattern: fileURLToPath(new URL("./**/*.sql", import.meta.url)),
    execQuery: (query) => sql.unsafe(query).then((rows) => ({ rows })),
    execSqlScript: (script) =>
      sql
        .unsafe(script)
        .simple()
        .then(() => undefined),
  });
  const applied = await postgrator.migrate();
  console.log(
    applied.length > 0
      ? `applied: ${applied.map((m) => `${m.version} ${m.name}`).join(", ")}`
      : "already up to date",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .catch((error) => {
      console.error("migrations failed:", error);
      process.exitCode = 1;
    })
    .finally(() => sql.end());
}
