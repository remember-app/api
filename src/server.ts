import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { sql } from "./integrations/db/index.ts";
import { storageConfigured } from "./integrations/storage/s3.ts";

storageConfigured();
const app = buildApp();
await sql`select 1`;
await app.listen({ port: config.server.port(), host: "0.0.0.0" });
