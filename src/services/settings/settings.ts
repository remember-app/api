import { sql } from "../../integrations/db/index.ts";
import {
  ANALYSIS_GRADING_KEY,
  ANALYSIS_PRICE_KEY,
  type AnalysisGradingItem,
  type AnalysisPrice,
  INVITE_REWARDS_KEY,
  type InviteRewards,
  type Reward,
} from "./defaults.ts";

const setting = async (key: string): Promise<unknown> => {
  const [row] = await sql<{ value: unknown }[]>`
    select value from settings where key = ${key}
  `;
  if (!row) throw new Error(`setting "${key}" is missing`);
  return row.value;
};

const reward = (value: unknown, key: string, side: string): Reward => {
  if (typeof value !== "object" || value === null) {
    throw new Error(`setting "${key}" has no ${side} reward`);
  }
  const row = value as Record<string, unknown>;
  const tokens = Number(row.tokens);
  const storageBytes = Number(row.storageBytes);
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`setting "${key}" has an invalid ${side} token reward`);
  }
  if (!Number.isSafeInteger(storageBytes) || storageBytes < 0) {
    throw new Error(`setting "${key}" has an invalid ${side} storage reward`);
  }
  return { tokens, storageBytes };
};

export async function inviteRewards(): Promise<InviteRewards> {
  const value = await setting(INVITE_REWARDS_KEY);
  if (typeof value !== "object" || value === null) {
    throw new Error(`setting "${INVITE_REWARDS_KEY}" is not an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    sender: reward(row.sender, INVITE_REWARDS_KEY, "sender"),
    invitee: reward(row.invitee, INVITE_REWARDS_KEY, "invitee"),
  };
}

export async function analysisPrice(): Promise<AnalysisPrice> {
  const value = await setting(ANALYSIS_PRICE_KEY);
  if (typeof value !== "object" || value === null) {
    throw new Error(`setting "${ANALYSIS_PRICE_KEY}" is not an object`);
  }
  const tokens = Number((value as Record<string, unknown>).tokens);
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`setting "${ANALYSIS_PRICE_KEY}" has an invalid token price`);
  }
  return { tokens };
}

export async function analysisGrading(): Promise<AnalysisGradingItem[]> {
  const value = await setting(ANALYSIS_GRADING_KEY);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`setting "${ANALYSIS_GRADING_KEY}" is not a non-empty array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`setting "${ANALYSIS_GRADING_KEY}" item ${index} is not an object`);
    }
    const row = item as Record<string, unknown>;
    const points = Number(row.points);
    if (!Number.isFinite(points)) {
      throw new Error(`setting "${ANALYSIS_GRADING_KEY}" item ${index} has no points`);
    }
    if (typeof row.question !== "string" || !row.question.trim()) {
      throw new Error(`setting "${ANALYSIS_GRADING_KEY}" item ${index} has no question`);
    }
    return { points, question: row.question.trim() };
  });
}
