import { type Db, sql } from "../../integrations/db/index.ts";
import type { Consumable } from "../../types/consumables.ts";
import type { ProjectId, UserId } from "../../types/id.ts";
import { type ConsumableRow, consumableColumns, toConsumable } from "./queries.ts";

export type Grant = {
  tokens?: number;
  storageBytes?: number;
};

export type Donation = {
  tokens?: number;
  storageBytes?: number;
};

export type DonationResult =
  | { ok: true; project: Consumable; member: Consumable }
  | { denial: "not_found" | "invalid" | "insufficient" };

const assertNonNegative = (value: number | undefined, name: string) => {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative number`);
  }
};

export async function grant(userId: UserId, grant: Grant): Promise<Consumable> {
  assertNonNegative(grant.tokens, "tokens");
  assertNonNegative(grant.storageBytes, "storageBytes");
  const [row] = await sql<ConsumableRow[]>`
    update users
    set tokens = users.tokens + ${grant.tokens ?? 0},
        storage_bytes = users.storage_bytes + ${grant.storageBytes ?? 0}
    where id = ${userId}
    returning ${consumableColumns}
  `;
  if (!row) throw new Error("user not found while granting consumables");
  return toConsumable(row);
}

export class StorageFullError extends Error {
  constructor() {
    super("project storage is exhausted");
    this.name = "StorageFullError";
  }
}

export async function spendProjectStorage(
  db: Db,
  projectId: ProjectId,
  userId: UserId,
  bytes: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return true;
  const [row] = await db<{ ok: boolean }[]>`
    update projects
    set storage_spend = storage_spend + ${bytes}
    where id = ${projectId} and storage_bytes - storage_spend >= ${bytes}
    returning true as ok
  `;
  if (!row) return false;
  await db`
    update project_members
    set storage_spend = storage_spend + ${bytes}
    where project_id = ${projectId} and user_id = ${userId}
  `;
  return true;
}

export async function spendProjectTokens(
  db: Db,
  projectId: ProjectId,
  userId: UserId,
  tokens: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return true;
  const [row] = await db<{ ok: boolean }[]>`
    update projects
    set tokens_spend = tokens_spend + ${tokens}
    where id = ${projectId} and tokens - tokens_spend >= ${tokens}
    returning true as ok
  `;
  if (!row) return false;
  await db`
    update project_members
    set tokens_spend = tokens_spend + ${tokens}
    where project_id = ${projectId} and user_id = ${userId}
  `;
  return true;
}

export async function spendUserTokens(db: Db, userId: UserId, tokens: number): Promise<boolean> {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return true;
  const [row] = await db<{ ok: boolean }[]>`
    update users
    set tokens_spend = tokens_spend + ${tokens}
    where id = ${userId} and tokens - tokens_spend >= ${tokens}
    returning true as ok
  `;
  return Boolean(row);
}

export async function adjustStorageSpend(
  db: Db,
  projectId: ProjectId,
  userId: UserId,
  deltaBytes: number,
): Promise<void> {
  if (!Number.isFinite(deltaBytes) || deltaBytes === 0) return;
  await db`
    update projects
    set storage_spend = greatest(0, storage_spend + ${deltaBytes})
    where id = ${projectId}
  `;
  await db`
    update project_members
    set storage_spend = greatest(0, storage_spend + ${deltaBytes})
    where project_id = ${projectId} and user_id = ${userId}
  `;
}

export async function donateToProject(
  projectId: ProjectId,
  userId: UserId,
  donation: Donation,
): Promise<DonationResult> {
  const tokens = donation.tokens ?? 0;
  const bytes = donation.storageBytes ?? 0;
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(bytes)) {
    return { denial: "invalid" };
  }
  if (tokens < 0 || bytes < 0) return { denial: "invalid" };
  if (tokens === 0 && bytes === 0) return { denial: "invalid" };

  return sql.begin(async (tx) => {
    const [member] = await tx<{ role: string }[]>`
      select role from project_members
      where project_id = ${projectId} and user_id = ${userId}
      for update
    `;
    if (!member) return { denial: "not_found" } as const;

    const [user] = await tx<ConsumableRow[]>`
      select ${consumableColumns} from users where id = ${userId} for update
    `;
    if (!user) return { denial: "not_found" } as const;
    const available = toConsumable(user);
    if (available.tokens.tokens - available.tokens.spend < tokens) {
      return { denial: "insufficient" } as const;
    }
    if (available.storage.bytes - available.storage.spend < bytes) {
      return { denial: "insufficient" } as const;
    }

    const [project] = await tx<ConsumableRow[]>`
      update projects
      set tokens = projects.tokens + ${tokens},
          storage_bytes = projects.storage_bytes + ${bytes}
      where id = ${projectId}
      returning tokens,
        tokens_spend as "tokensSpend",
        storage_bytes as "storageBytes",
        storage_spend as "storageSpend"
    `;
    const [membership] = await tx<ConsumableRow[]>`
      update project_members
      set tokens = project_members.tokens + ${tokens},
          storage_bytes = project_members.storage_bytes + ${bytes}
      where project_id = ${projectId} and user_id = ${userId}
      returning tokens,
        tokens_spend as "tokensSpend",
        storage_bytes as "storageBytes",
        storage_spend as "storageSpend"
    `;
    await tx`
      update users
      set tokens_spend = users.tokens_spend + ${tokens},
          storage_spend = users.storage_spend + ${bytes}
      where id = ${userId}
    `;
    if (!project || !membership) throw new Error("donation update returned no row");
    return { ok: true, project: toConsumable(project), member: toConsumable(membership) };
  });
}
