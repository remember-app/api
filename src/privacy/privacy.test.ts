import { afterAll, expect, test, vi } from "vitest";
import { buildApp } from "../app.ts";

// A spy instead of Postgres: the file runs with no database at all, and any
// query the page made would show up as a call.
const sql = vi.hoisted(() => vi.fn());
vi.mock("../db.ts", () => ({ sql }));

const app = buildApp();
afterAll(() => app.close());

test("GET /privacy is public, static HTML with both languages", async () => {
  sql.mockClear();
  const res = await app.inject({ method: "GET", url: "/privacy" });

  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["content-security-policy"]).toBe(
    "default-src 'none'; style-src 'unsafe-inline'",
  );
  expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  expect(sql).not.toHaveBeenCalled();

  for (const text of [
    "<h1>Политика конфиденциальности Remember</h1>",
    "<h1>Remember Privacy Policy</h1>",
    "Редакция от 25 сентября 2026 года",
    "Last updated: September 25, 2026",
    '<section id="ru" lang="ru">',
    '<section id="en" lang="en">',
    '<a href="mailto:dev@noxlabs.xyz">dev@noxlabs.xyz</a>',
  ]) {
    expect(res.body).toContain(text);
  }

  expect(res.body).not.toMatch(/https?:|\/\/|<script|<link|<img|<iframe|src=|url\(|@import/i);
  for (const [, href] of res.body.matchAll(/href="([^"]*)"/g)) {
    expect(href).toMatch(/^(#ru|#en|mailto:dev@noxlabs\.xyz)$/);
  }
});

test("GET /privacy ignores a session it cannot verify", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/privacy",
    headers: { authorization: "Bearer not-a-session" },
  });

  expect(res.statusCode).toBe(200);
});
