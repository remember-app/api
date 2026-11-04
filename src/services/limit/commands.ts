import { sql } from "../../integrations/db/index.ts";
import type { UserId } from "../../types/id.ts";
import type { UserLimit } from "../../types/limit.ts";
import { limitColumns } from "./queries.ts";

export type Grant = {
  tokens?: number;
  storageBytes?: number;
};

const assertNonNegative = (value: number | undefined, name: string) => {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative number`);
  }
};

export async function grant(userId: UserId, grant: Grant): Promise<UserLimit> {
  assertNonNegative(grant.tokens, "tokens");
  assertNonNegative(grant.storageBytes, "storageBytes");
  const [row] = await sql<UserLimit[]>`
    insert into user_limits (user_id, tokens, storage_bytes)
    values (${userId}, ${grant.tokens ?? 0}, ${grant.storageBytes ?? 0})
    on conflict (user_id) do update
    set tokens = user_limits.tokens + excluded.tokens,
        storage_bytes = user_limits.storage_bytes + excluded.storage_bytes
    returning ${limitColumns}
  `;
  if (!row) throw new Error("user_limits grant returned no row");
  return row;
}
