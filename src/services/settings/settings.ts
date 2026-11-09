import { sql } from "../../integrations/db/index.ts";
import {
  DEFAULT_INVITE_REWARDS,
  INVITE_REWARDS_KEY,
  type InviteRewards,
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
