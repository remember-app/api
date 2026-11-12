import { login, type Person, post, type Token } from "../common.ts";

const PEOPLE: Person[] = [
  { email: "a@x.io", username: "alice", name: "Алиса", language: "ru" },
  { email: "b@x.io", username: "bob", name: "Bob", language: "en" },
  { email: "c@x.io", username: "carol", name: "Кэрол", language: "ru" },
  { email: "d@x.io", username: "dave", name: "Dave", language: "en" },
];

export async function seedUsers(): Promise<Map<string, Token>> {
  const tokens = new Map<string, Token>();
  for (const person of PEOPLE) {
    const session = await login(person.email);
    tokens.set(person.username, session.token);
    await post("/v1/me/username", session.token, { username: person.username });
    await post("/v1/me/name", session.token, { name: person.name });
    await post("/v1/me/language", session.token, { language: person.language });
    console.log(`test seed: user ${person.username}`);
  }
  return tokens;
}
