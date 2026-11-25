import { sql } from "../../src/integrations/db/index.ts";
import { migrate } from "./migrations/index.ts";
import { seed } from "./seeds/index.ts";

try {
  await migrate();
  await seed();
} catch (error) {
  console.error("deploy-worker: failed:", error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
