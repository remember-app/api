import assert from "node:assert/strict";
import { test } from "node:test";
import { loginCodeLetter } from "./login-code.ts";

test("both letters put every code digit into its own cell", () => {
  for (const language of ["ru", "en"] as const) {
    const { html, text } = loginCodeLetter[language]("482916", 15);
    assert.match(text, /482916/);
    assert.deepEqual(
      [...html.matchAll(/class="code-cell"[^>]*>(.)</g)].map((match) => match[1]),
      ["4", "8", "2", "9", "1", "6"],
    );
  }
});

test("letter declares both color schemes instead of relying on client inversion", () => {
  const { html } = loginCodeLetter.ru("482916", 15);
  assert.match(html, /name="color-scheme" content="light dark"/);
  assert.match(html, /@media only screen and \(prefers-color-scheme: dark\)/);
});

test("letter inlines the full three-color logo without an attachment", () => {
  const { html } = loginCodeLetter.ru("482916", 15);
  assert.match(html, /<svg[^>]*viewBox/);
  for (const color of ["logo-ink", "logo-blue", "logo-spark"])
    assert.match(html, new RegExp(color));
  assert.doesNotMatch(html, /cid:remember-logo/);
});

test("Russian expiry uses the right word for any TTL", () => {
  assert.match(loginCodeLetter.ru("000000", 1).html, /1 минуту/);
  assert.match(loginCodeLetter.ru("000000", 2).html, /2 минуты/);
  assert.match(loginCodeLetter.ru("000000", 5).html, /5 минут/);
  assert.match(loginCodeLetter.ru("000000", 21).html, /21 минуту/);
});
