import Fastify from "fastify";

/**
 * The HTTP app, with no database and no listener attached — so tests can
 * build it and call `app.inject()` without any external service.
 */
export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // Cross-repo contract, locked by src/app.test.ts: 200, JSON, body exactly
  // {"status":"ok"}. Fastify always sends `application/json; charset=utf-8`
  // (it re-appends the charset whichever way the header is set), so clients
  // must match the content-type by prefix, not by equality.
  app.get("/health", () => ({ status: "ok" }));

  return app;
}
