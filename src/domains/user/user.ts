import { sql } from "../../integrations/db/index.ts";
import type { UserId } from "../../types/id.ts";
import type { User, UserPublic } from "../../types/user.ts";

const userColumns = sql`id, username, name, email`;
const publicColumns = sql`id, username, name`;
const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,28}[a-zA-Z0-9]$/;

export const isValidUsername = (username: string) => usernamePattern.test(username);

export async function getUser(id: UserId): Promise<User | undefined> {
  const [row] = await sql<User[]>`select ${userColumns} from users where id = ${id}`;
  return row;
}

export async function getPublicUser(id: UserId): Promise<UserPublic | undefined> {
  const [row] = await sql<UserPublic[]>`select ${publicColumns} from users where id = ${id}`;
  return row;
}

export async function findByUsername(username: string): Promise<UserPublic | undefined> {
  if (!isValidUsername(username)) return undefined;
  const [row] = await sql<UserPublic[]>`
    select ${publicColumns} from users where username = ${username}
  `;
  return row;
}

export async function usernameAvailable(username: string, selfId: UserId): Promise<boolean> {
  if (!isValidUsername(username)) return false;
  const rows = await sql`
    select 1 from users where username = ${username} and id <> ${selfId}
  `;
  return rows.length === 0;
}

export type SetUsernameResult = { user: User } | { denial: "invalid" | "taken" | "not_found" };

export async function setUsername(userId: UserId, username: string): Promise<SetUsernameResult> {
  if (!isValidUsername(username)) return { denial: "invalid" };
  try {
    const [row] = await sql<User[]>`
      update users set username = ${username} where id = ${userId} returning ${userColumns}
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
    update users set name = ${name} where id = ${userId} returning ${userColumns}
  `;
  return row;
}
