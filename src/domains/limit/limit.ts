import { sql } from "../../integrations/db/index.ts";
import type { UserId } from "../../types/id.ts";
import type { UserLimit } from "../../types/limit.ts";

const columns = sql`user_id as "userId", tokens, storage_bytes as "storageBytes"`;

export type Grant = {
  tokens?: number;
  storageBytes?: number;
};

const assertNonNegative = (value: number | undefined, name: string) => {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative number`);
  }
};

export async function getLimit(userId: UserId): Promise<UserLimit> {
  const [row] = await sql<UserLimit[]>`
    insert into user_limits (user_id) values (${userId})
    on conflict (user_id) do update set user_id = excluded.user_id
    returning ${columns}
  `;
  if (!row) throw new Error("user_limits upsert returned no row");
  return row;
}

export async function grant(userId: UserId, grant: Grant): Promise<UserLimit> {
  assertNonNegative(grant.tokens, "tokens");
  assertNonNegative(grant.storageBytes, "storageBytes");
  const [row] = await sql<UserLimit[]>`
    insert into user_limits (user_id, tokens, storage_bytes)
    values (${userId}, ${grant.tokens ?? 0}, ${grant.storageBytes ?? 0})
    on conflict (user_id) do update
    set tokens = user_limits.tokens + excluded.tokens,
        storage_bytes = user_limits.storage_bytes + excluded.storage_bytes
    returning ${columns}
  `;
  if (!row) throw new Error("user_limits grant returned no row");
  return row;
}

export async function charge(userId: UserId, cost: Grant): Promise<UserLimit | undefined> {
  assertNonNegative(cost.tokens, "tokens");
  assertNonNegative(cost.storageBytes, "storageBytes");
  const tokens = cost.tokens ?? 0;
  const storageBytes = cost.storageBytes ?? 0;
  const [row] = await sql<UserLimit[]>`
    update user_limits
    set tokens = tokens - ${tokens},
        storage_bytes = storage_bytes - ${storageBytes}
    where user_id = ${userId}
      and tokens >= ${tokens}
      and storage_bytes >= ${storageBytes}
    returning ${columns}
  `;
  return row;
}

export async function canAfford(userId: UserId, cost: Grant): Promise<boolean> {
  const limit = await getLimit(userId);
  return limit.tokens >= (cost.tokens ?? 0) && limit.storageBytes >= (cost.storageBytes ?? 0);
}
