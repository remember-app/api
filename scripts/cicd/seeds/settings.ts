import { sql } from "../../../src/integrations/db/index.ts";
import {
  ANALYSIS_GRADING_IMPORTANCE_KEY,
  ANALYSIS_GRADING_QUALITY_KEY,
  ANALYSIS_LEVEL_KEY,
  ANALYSIS_PRICE_KEY,
  DEFAULT_ANALYSIS_GRADING_IMPORTANCE,
  DEFAULT_ANALYSIS_GRADING_QUALITY,
  DEFAULT_ANALYSIS_LEVEL,
  DEFAULT_ANALYSIS_PRICE,
  DEFAULT_MONTAGE_LEVEL,
  DEFAULT_MONTAGE_PRICE,
  DEFAULT_MUSIC_GRADING,
  INVITE_REWARDS_KEY,
  type InviteRewards,
  MONTAGE_LEVEL_KEY,
  MONTAGE_PRICE_KEY,
  MUSIC_GRADING_KEY,
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
    value: DEFAULT_ANALYSIS_PRICE,
  },
  {
    key: ANALYSIS_GRADING_IMPORTANCE_KEY,
    value: DEFAULT_ANALYSIS_GRADING_IMPORTANCE,
  },
  {
    key: ANALYSIS_GRADING_QUALITY_KEY,
    value: DEFAULT_ANALYSIS_GRADING_QUALITY,
  },
  {
    key: MUSIC_GRADING_KEY,
    value: DEFAULT_MUSIC_GRADING,
  },
  {
    key: ANALYSIS_LEVEL_KEY,
    value: DEFAULT_ANALYSIS_LEVEL,
  },
  {
    key: MONTAGE_LEVEL_KEY,
    value: DEFAULT_MONTAGE_LEVEL,
  },
  {
    key: MONTAGE_PRICE_KEY,
    value: DEFAULT_MONTAGE_PRICE,
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
  // The single grading list became three scored blocks; drop the leftover.
  await sql`delete from settings where key = 'analysis.grading'`;
  for (const setting of SETTINGS) {
    await sql`
      insert into settings (key, value)
      values (${setting.key}, ${sql.json(setting.value)})
      on conflict (key) do update set value = excluded.value
    `;
    console.log(`essentials: setting ${setting.key}`);
  }
}
