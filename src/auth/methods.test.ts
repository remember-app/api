import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../app.ts";

// A spy instead of Postgres: the file runs with no database at all, and any
// query the route made would show up as a call.
const sql = vi.hoisted(() => vi.fn());
vi.mock("../db.ts", () => ({ sql }));

const app = buildApp();
afterAll(() => app.close());

beforeEach(() => {
  sql.mockClear();
  vi.stubEnv("APPLE_CLIENT_ID", undefined);
  vi.stubEnv("GOOGLE_CLIENT_ID", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const methods = (headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/auth/methods", headers });

test("with no provider settings only email is on, publicly, cached and without the database", async () => {
  const res = await methods();

  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toMatch(/^application\/json/);
  expect(res.headers["cache-control"]).toBe("public, max-age=300");
  expect(res.json()).toEqual({ email: true, apple: false, google: false });
  expect(sql).not.toHaveBeenCalled();
});

test("apple and google are each switched on by their own setting alone", async () => {
  vi.stubEnv("APPLE_CLIENT_ID", "xyz.remember.ios");
  expect((await methods()).json()).toEqual({ email: true, apple: true, google: false });

  vi.stubEnv("APPLE_CLIENT_ID", undefined);
  vi.stubEnv("GOOGLE_CLIENT_ID", "4242-qwerty.apps.googleusercontent.com");
  expect((await methods()).json()).toEqual({ email: true, apple: false, google: true });
});

test("a blank or whitespace setting is off", async () => {
  vi.stubEnv("APPLE_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_CLIENT_ID", " \t ");

  expect((await methods()).json()).toEqual({ email: true, apple: false, google: false });
});

test("the answer never carries the client ids or any piece of them", async () => {
  const ids = ["xyz.remember.ios", "4242-qwerty.apps.googleusercontent.com"];
  vi.stubEnv("APPLE_CLIENT_ID", ids[0]);
  vi.stubEnv("GOOGLE_CLIENT_ID", ids[1]);

  const res = await methods();

  expect(res.body).toBe('{"email":true,"apple":true,"google":true}');
  for (const piece of ids.flatMap((id) => id.split(/[.-]/))) {
    expect(res.body).not.toContain(piece);
  }
});

test("a session it cannot verify changes nothing", async () => {
  const res = await methods({ authorization: "Bearer not-a-session" });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ email: true, apple: false, google: false });
  expect(sql).not.toHaveBeenCalled();
});
