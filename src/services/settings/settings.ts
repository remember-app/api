import { sql } from "../../integrations/db/index.ts";
import {
  ANALYSIS_PRICE_KEY,
  type AnalysisPrice,
  DEFAULT_ANALYSIS_PRICE,
  DEFAULT_INVITE_REWARDS,
  DEFAULT_PROVIDER_RATES,
  INVITE_REWARDS_KEY,
  type InviteRewards,
  PROVIDER_RATES_KEY,
  type ProviderRate,
  type ProviderRates,
  type Reward,
} from "./defaults.ts";

const reward = (value: unknown, fallback: Reward): Reward => {
  if (typeof value !== "object" || value === null) return fallback;
  const row = value as Record<string, unknown>;
  const tokens = Number(row.tokens);
  const storageBytes = Number(row.storageBytes);
  if (!Number.isSafeInteger(tokens) || tokens < 0) return fallback;
  if (!Number.isSafeInteger(storageBytes) || storageBytes < 0) return fallback;
  return { tokens, storageBytes };
};

export async function inviteRewards(): Promise<InviteRewards> {
  const [row] = await sql<{ value: unknown }[]>`
    select value from settings where key = ${INVITE_REWARDS_KEY}
  `;
  if (!row || typeof row.value !== "object" || row.value === null) return DEFAULT_INVITE_REWARDS;
  const value = row.value as Record<string, unknown>;
  return {
    sender: reward(value.sender, DEFAULT_INVITE_REWARDS.sender),
    invitee: reward(value.invitee, DEFAULT_INVITE_REWARDS.invitee),
  };
}

const providerRate = (value: unknown): ProviderRate | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const input = Number(row.inputPerMillionUsd);
  const output = Number(row.outputPerMillionUsd);
  const cached = Number(row.cachedInputPerMillionUsd);
  if (![input, output, cached].every((one) => Number.isFinite(one) && one >= 0)) return undefined;
  return {
    inputPerMillionUsd: input,
    outputPerMillionUsd: output,
    cachedInputPerMillionUsd: cached,
  };
};

export async function providerRates(): Promise<ProviderRates> {
  const [row] = await sql<{ value: unknown }[]>`
    select value from settings where key = ${PROVIDER_RATES_KEY}
  `;
  if (!row || typeof row.value !== "object" || row.value === null) return DEFAULT_PROVIDER_RATES;
  const rates: ProviderRates = {};
  for (const [model, value] of Object.entries(row.value as Record<string, unknown>)) {
    const parsed = providerRate(value);
    if (parsed) rates[model] = parsed;
  }
  return Object.keys(rates).length > 0 ? rates : DEFAULT_PROVIDER_RATES;
}

export async function analysisPrice(): Promise<AnalysisPrice> {
  const [row] = await sql<{ value: unknown }[]>`
    select value from settings where key = ${ANALYSIS_PRICE_KEY}
  `;
  if (!row || typeof row.value !== "object" || row.value === null) return DEFAULT_ANALYSIS_PRICE;
  const tokens = Number((row.value as Record<string, unknown>).tokens);
  if (!Number.isSafeInteger(tokens) || tokens < 0) return DEFAULT_ANALYSIS_PRICE;
  return { tokens };
}
