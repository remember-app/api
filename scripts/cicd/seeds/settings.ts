import { sql } from "../../../src/integrations/db/index.ts";
import {
  ANALYSIS_GRADING_KEY,
  ANALYSIS_PRICE_KEY,
  type AnalysisPrice,
  DEFAULT_ANALYSIS_GRADING,
  INVITE_REWARDS_KEY,
  type InviteRewards,
} from "../../../src/services/settings/defaults.ts";

const PROVIDER_RATES_KEY = "ai.providerRates";

type Json = Parameters<typeof sql.json>[0];

const SETTINGS: { key: string; value: Json }[] = [
  {
    key: INVITE_REWARDS_KEY,
    value: {
      sender: { tokens: 50, storageBytes: 5 * 1024 ** 3 },
      invitee: { tokens: 50, storageBytes: 5 * 1024 ** 3 },
    } satisfies InviteRewards,
  },
  {
    key: ANALYSIS_PRICE_KEY,
    value: { tokens: 1 } satisfies AnalysisPrice,
  },
  {
    key: ANALYSIS_GRADING_KEY,
    value: DEFAULT_ANALYSIS_GRADING,
  },
  {
    key: PROVIDER_RATES_KEY,
    value: {
      "gemini-3.8-flash": {
        inputPerMillionUsd: 0.75,
        outputPerMillionUsd: 3.75,
        cachedInputPerMillionUsd: 0.075,
      },
    },
  },
];

export async function seedSettings(): Promise<void> {
  for (const setting of SETTINGS) {
    await sql`
      insert into settings (key, value)
      values (${setting.key}, ${sql.json(setting.value)})
      on conflict (key) do update set value = excluded.value
    `;
    console.log(`essentials: setting ${setting.key}`);
  }
}
