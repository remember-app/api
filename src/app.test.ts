import { expect, test } from "vitest";
import { buildApp } from "./app.ts";

test('GET /health answers 200 with exactly {"status":"ok"}', async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });

  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  expect(res.body).toBe('{"status":"ok"}');

  await app.close();
});
