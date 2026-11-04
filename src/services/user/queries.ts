import { sql } from "../../integrations/db/index.ts";
import type { UserId } from "../../types/id.ts";
import type { User, UserPublic } from "../../types/user.ts";
import { getLimit } from "../limit/queries.ts";
import { isValidUsername, publicColumns, userColumns } from "./internal.ts";

export type AccountView = User & {
  limits: { tokens: string; storageBytes: string };
};

export async function accountView(userId: UserId): Promise<AccountView | undefined> {
  const user = await getUser(userId);
  if (!user) return undefined;
  const limits = await getLimit(userId);
  return {
    ...user,
    limits: {
      tokens: String(limits.tokens),
      storageBytes: String(limits.storageBytes),
    },
  };
}

export async function getUser(id: UserId): Promise<User | undefined> {
  const [row] = await sql<User[]>`select ${userColumns} from users where id = ${id}`;
  return row;
}

export async function getPublicUsers(ids: UserId[]): Promise<UserPublic[]> {
  if (ids.length === 0) return [];
  return sql<UserPublic[]>`
    select ${publicColumns} from users where id = any(${ids})
  `;
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
