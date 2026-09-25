import { buildApp } from "./app.ts";
import { sql } from "./db.ts";
import { storageConfigured } from "./media/r2.ts";

// A storage driver misspelt, or a google key, bucket or prefix missing or
// broken, stops the server here with the reason — rather than letting it
// answer 503 to every upload.
storageConfigured();

const app = buildApp();

// Fail fast and loudly if the database is unreachable, rather than serving
// a healthy-looking API on top of nothing.
await sql`select 1`;

// 0.0.0.0 so a phone or simulator on the same network can reach the dev server.
// `|| 3000` and not `?? 3000`: an unparseable PORT would otherwise become NaN,
// which Node silently reads as "any free port".
await app.listen({ port: Number(process.env.PORT) || 3000, host: "0.0.0.0" });
