import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";

const email = () => testEmail("task128");

afterAll(async () => {
  // Contacts cascade off users on both ends, so clearing the people clears
  // their lists — and their presence in anybody else's.
  await cleanupTestUsers("task128");
  await sql.end();
});

type App = ReturnType<typeof buildTestApp>["app"];

const as = (token: string, options: InjectOptions) => ({
  ...options,
  headers: { authorization: `Bearer ${token}` },
});

/**
 * A signed-in person holding a username, since that is the only way one is
 * saved. `prefix` is how a test pins the alphabetical order the list promises.
 */
async function person(app: App, prefix = "t128") {
  const { token, user } = await signIn(app, email());
  const username = `${prefix}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const named = await app.inject(
    as(token, { method: "POST", url: "/me/username", payload: { username } }),
  );
  expect(named.statusCode).toBe(200);
  return { token, id: user.id, username };
}

const add = (app: App, token: string, username: unknown) =>
  app.inject(as(token, { method: "POST", url: "/me/contacts", payload: { username } }));

const list = (app: App, token: string) =>
  app.inject(as(token, { method: "GET", url: "/me/contacts" }));

const remove = (app: App, token: string, userId: string) =>
  app.inject(as(token, { method: "DELETE", url: `/me/contacts/${userId}` }));

/** Кто в списке, в том порядке, в котором его отдали. */
const ids = async (app: App, token: string) => {
  const answer = await list(app, token);
  expect(answer.statusCode).toBe(200);
  return answer.json().map((contact: { id: string }) => contact.id);
};

test("сохранить по нику: тот же ответ, что у поиска, и повтор ничего не меняет", async () => {
  const { app } = buildTestApp();
  const owner = await person(app);
  const saved = await person(app);

  const first = await add(app, owner.token, saved.username);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ id: saved.id, username: saved.username, name: null });

  // Точное совпадение регистронезависимо — как и в поиске по нику.
  const again = await add(app, owner.token, saved.username.toUpperCase());
  expect(again.statusCode).toBe(200);

  const mine = await list(app, owner.token);
  expect(mine.statusCode).toBe(200);
  expect(mine.json()).toEqual([{ id: saved.id, username: saved.username, name: null }]);

  // Связь односторонняя: у сохранённого в списке не появилось никого.
  expect((await list(app, saved.token)).json()).toEqual([]);

  await app.close();
});

test("несуществующий ник — 404, сам себя — 400", async () => {
  const { app } = buildTestApp();
  const owner = await person(app);

  const unknown = await add(app, owner.token, `t128nobody${randomUUID().slice(0, 8)}`);
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json()).toEqual({ error: "not found" });

  // Ник, который вообще нельзя занять, — тот же 404, не 400.
  const impossible = await add(app, owner.token, "не ник");
  expect(impossible.statusCode).toBe(404);

  const self = await add(app, owner.token, owner.username);
  expect(self.statusCode).toBe(400);
  expect(self.json()).toEqual({ error: "cannot add yourself" });

  expect((await list(app, owner.token)).json()).toEqual([]);

  await app.close();
});

test("список — по нику, и удаление убирает из него", async () => {
  const { app } = buildTestApp();
  const owner = await person(app);
  const bravo = await person(app, "t128b");
  const alpha = await person(app, "t128a");

  // Сохранены в обратном порядке: список отдаётся по нику, а не по времени.
  expect((await add(app, owner.token, bravo.username)).statusCode).toBe(200);
  expect((await add(app, owner.token, alpha.username)).statusCode).toBe(200);
  expect(await ids(app, owner.token)).toEqual([alpha.id, bravo.id]);

  const dropped = await remove(app, owner.token, alpha.id);
  expect(dropped.statusCode).toBe(200);
  expect(dropped.json()).toEqual({ ok: true });
  expect(await ids(app, owner.token)).toEqual([bravo.id]);

  // Удалить дважды и удалить того, кого не сохраняли, — один и тот же ответ.
  expect((await remove(app, owner.token, alpha.id)).statusCode).toBe(404);
  // Не uuid — тоже 404, а не 500 из базы.
  expect((await remove(app, owner.token, "не-uuid")).statusCode).toBe(404);

  await app.close();
});

test("список виден только хозяину: чужой не читается и не правится", async () => {
  const { app } = buildTestApp();
  const a = await person(app);
  const b = await person(app);
  const saved = await person(app);
  const other = await person(app);

  expect((await add(app, a.token, saved.username)).statusCode).toBe(200);
  expect((await add(app, a.token, other.username)).statusCode).toBe(200);

  // У B свой список, и он пуст: чужие контакты в него не попадают ни при
  // каком раскладе — ни ролей, ни участия здесь просто нет.
  expect((await list(app, b.token)).json()).toEqual([]);

  // Чужой контакт по id: B знает id, но удалить его из списка A не может, и
  // ответ — тот же 404, что и на никогда не сохранённого.
  const stolen = await remove(app, b.token, saved.id);
  expect(stolen.statusCode).toBe(404);
  expect(stolen.json()).toEqual({ error: "not found" });

  // Список A цел.
  expect((await ids(app, a.token)).sort()).toEqual([saved.id, other.id].sort());

  // И наоборот: B сохраняет того же человека себе — это его собственная
  // строка, на список A она не влияет.
  expect((await add(app, b.token, saved.username)).statusCode).toBe(200);
  expect((await remove(app, b.token, saved.id)).statusCode).toBe(200);
  expect(await ids(app, a.token)).toHaveLength(2);

  // Без токена — 401, а не пустой список.
  const anonymous = await app.inject({ method: "GET", url: "/me/contacts" });
  expect(anonymous.statusCode).toBe(401);

  await app.close();
});
