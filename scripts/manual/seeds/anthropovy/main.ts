import { sql } from "../../../../src/integrations/db/index.ts";
import { seedAnthropovy } from "./seed.ts";

const username = process.argv[2]?.trim() ?? "";

try {
  if (!username) throw new Error("usage: node scripts/manual/seeds/anthropovy/main.ts <nickname>");
  await seedAnthropovy(username);
} catch (error) {
  console.error("test seed failed:", error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
