export type Reward = { tokens: number; storageBytes: number };

export type InviteRewards = { sender: Reward; invitee: Reward };

export const INVITE_REWARDS_KEY = "invites.rewards";

export const DEFAULT_INVITE_REWARDS: InviteRewards = {
  sender: { tokens: 50, storageBytes: 100 * 1024 ** 3 },
  invitee: { tokens: 50, storageBytes: 100 * 1024 ** 3 },
};
