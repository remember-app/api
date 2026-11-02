import { buildApp } from "./app.ts";
import { sql } from "./db.ts";
import { storageConfigured } from "./media/r2.ts";

storageConfigured();
const app = buildApp();
await sql`select 1`;
await app.listen({ port: Number(process.env.PORT) || 3000, host: "0.0.0.0" });
