import { buildApp } from "./app.ts";
import { sql } from "./db.ts";

const app = buildApp();

// Fail fast and loudly if the database is unreachable, rather than serving
// a healthy-looking API on top of nothing.
await sql`select 1`;

// 0.0.0.0 so a phone or simulator on the same network can reach the dev server.
// `|| 3000` and not `?? 3000`: an unparseable PORT would otherwise become NaN,
// which Node silently reads as "any free port".
await app.listen({ port: Number(process.env.PORT) || 3000, host: "0.0.0.0" });
