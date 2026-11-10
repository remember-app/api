import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { sql } from "./integrations/db/index.ts";
import { storageConfigured } from "./integrations/storage/s3.ts";

storageConfigured();
const app = buildApp();
await sql`select 1`;
await app.listen({ port: config.server.port(), host: "0.0.0.0" });

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
  } finally {
    await sql.end({ timeout: 5 });
  }
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
