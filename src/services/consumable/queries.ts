import { sql } from "../../integrations/db/index.ts";
import type { Consumable } from "../../types/consumables.ts";
import type { UserId } from "../../types/id.ts";

export type ConsumableRow = {
  tokens: string;
  tokensSpend: string;
  storageBytes: string;
  storageSpend: string;
};

export const consumableColumns = sql`
  tokens,
  tokens_spend as "tokensSpend",
  storage_bytes as "storageBytes",
  storage_spend as "storageSpend"
`;

export function toConsumable(row: ConsumableRow): Consumable {
  return {
    tokens: { tokens: Number(row.tokens), spend: Number(row.tokensSpend) },
    storage: { bytes: Number(row.storageBytes), spend: Number(row.storageSpend) },
  };
}

export async function getConsumables(userId: UserId): Promise<Consumable> {
  const [row] = await sql<ConsumableRow[]>`
    select ${consumableColumns} from users where id = ${userId}
  `;
  if (!row) throw new Error("user not found while reading consumables");
  return toConsumable(row);
}
