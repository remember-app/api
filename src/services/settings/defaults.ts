export type Reward = { tokens: number; storageBytes: number };

export type InviteRewards = { sender: Reward; invitee: Reward };

export type AnalysisPrice = { tokens: number };

export const INVITE_REWARDS_KEY = "invites.rewards";

export const ANALYSIS_PRICE_KEY = "analysis.price";

export const DEFAULT_INVITE_REWARDS: InviteRewards = {
  sender: { tokens: 50, storageBytes: 100 * 1024 ** 3 },
  invitee: { tokens: 50, storageBytes: 100 * 1024 ** 3 },
};

export const DEFAULT_ANALYSIS_PRICE: AnalysisPrice = { tokens: 1 };
