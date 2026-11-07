import { sql } from "../../integrations/db/index.ts";
import type { UserId } from "../../types/id.ts";
import type { Language, User } from "../../types/user.ts";
import { isValidUsername, userColumns } from "./internal.ts";

export type SetUsernameResult = { user: User } | { denial: "invalid" | "taken" | "not_found" };

export async function setUsername(userId: UserId, username: string): Promise<SetUsernameResult> {
  if (!isValidUsername(username)) return { denial: "invalid" };
  try {
    const [row] = await sql<User[]>`
      update users set username = ${username}, registered = true
      where id = ${userId}
      returning ${userColumns}
    `;
    if (!row) return { denial: "not_found" };
    return { user: row };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return { denial: "taken" };
    throw error;
  }
}

export async function setName(userId: UserId, name: string | null): Promise<User | undefined> {
  const [row] = await sql<User[]>`
    update users set name = ${name ?? ""} where id = ${userId} returning ${userColumns}
  `;
  return row;
}

export async function setLanguage(userId: UserId, language: Language): Promise<User | undefined> {
  const [row] = await sql<User[]>`
    update users set language = ${language} where id = ${userId} returning ${userColumns}
  `;
  return row;
}
