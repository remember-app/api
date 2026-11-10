export type Reward = { tokens: number; storageBytes: number };

export type InviteRewards = { sender: Reward; invitee: Reward };

export type AnalysisPrice = { tokens: number };

export type ProviderRate = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
};

export type ProviderRates = Record<string, ProviderRate>;

export const INVITE_REWARDS_KEY = "invites.rewards";

export const ANALYSIS_PRICE_KEY = "analysis.price";

export const PROVIDER_RATES_KEY = "ai.providerRates";

export const DEFAULT_INVITE_REWARDS: InviteRewards = {
  sender: { tokens: 50, storageBytes: 100 * 1024 ** 3 },
  invitee: { tokens: 50, storageBytes: 100 * 1024 ** 3 },
};

export const DEFAULT_ANALYSIS_PRICE: AnalysisPrice = { tokens: 1 };

export const DEFAULT_PROVIDER_RATES: ProviderRates = {
  "gemini-3.8-flash": {
    inputPerMillionUsd: 0.75,
    outputPerMillionUsd: 3.75,
    cachedInputPerMillionUsd: 0.075,
  },
};
