import { sql } from "../../integrations/db/index.ts";
import type { MontageLevel } from "../../types/montage.ts";
import type { AnalysisLevel } from "../../types/project.ts";
import {
  ANALYSIS_GRADING_KEY,
  ANALYSIS_LEVEL_KEY,
  ANALYSIS_PRICE_KEY,
  type AnalysisGradingItem,
  type AnalysisPrice,
  type AnalysisPriceRate,
  DEFAULT_ANALYSIS_LEVEL,
  DEFAULT_MONTAGE_LEVEL,
  DEFAULT_MONTAGE_PRICE,
  INVITE_REWARDS_KEY,
  type InviteRewards,
  MONTAGE_LEVEL_KEY,
  MONTAGE_PRICE_KEY,
  type MontagePrice,
  type Reward,
} from "./defaults.ts";

const LEVELS = ["low", "medium", "high"] as const;

const setting = async (key: string): Promise<unknown> => {
  const [row] = await sql<{ value: unknown }[]>`
    select value from settings where key = ${key}
  `;
  if (!row) throw new Error(`setting "${key}" is missing`);
  return row.value;
};

const optionalSetting = async (key: string): Promise<unknown> => {
  const [row] = await sql<{ value: unknown }[]>`
    select value from settings where key = ${key}
  `;
  return row?.value;
};

const level = <T extends string>(value: unknown, key: string, fallback: T): T => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !(LEVELS as readonly string[]).includes(value)) {
    throw new Error(`setting "${key}" is not a level`);
  }
  return value as T;
};

export async function analysisLevel(): Promise<AnalysisLevel> {
  return level(
    await optionalSetting(ANALYSIS_LEVEL_KEY),
    ANALYSIS_LEVEL_KEY,
    DEFAULT_ANALYSIS_LEVEL,
  );
}

export async function montageLevel(): Promise<MontageLevel> {
  return level(await optionalSetting(MONTAGE_LEVEL_KEY), MONTAGE_LEVEL_KEY, DEFAULT_MONTAGE_LEVEL);
}

export async function montagePrice(): Promise<MontagePrice> {
  const value = await optionalSetting(MONTAGE_PRICE_KEY);
  if (value === undefined || value === null) return DEFAULT_MONTAGE_PRICE;
  if (typeof value !== "object") {
    throw new Error(`setting "${MONTAGE_PRICE_KEY}" is not an object`);
  }
  const row = value as Record<string, unknown>;
  const price: MontagePrice = {};
  for (const level of LEVELS) {
    const rate = row[level];
    if (rate === undefined) continue;
    const tokens = Number(rate);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error(`setting "${MONTAGE_PRICE_KEY}.${level}" has an invalid token price`);
    }
    price[level] = tokens;
  }
  return price;
}

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

const PRICE_UNITS = ["file", "second", "frame"] as const;

const priceRate = (value: unknown, key: string): AnalysisPriceRate => {
  if (typeof value !== "object" || value === null) {
    throw new Error(`setting "${key}" is not an object`);
  }
  const row = value as Record<string, unknown>;
  const unit = row.unit;
  if (typeof unit !== "string" || !(PRICE_UNITS as readonly string[]).includes(unit)) {
    throw new Error(`setting "${key}" has an invalid unit`);
  }
  const tokens = Number(row.tokens);
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`setting "${key}" has an invalid token price`);
  }
  return { unit: unit as AnalysisPriceRate["unit"], tokens };
};

const priceKind = (
  value: unknown,
  key: string,
): Partial<Record<AnalysisLevel, AnalysisPriceRate>> => {
  if (typeof value !== "object" || value === null) {
    throw new Error(`setting "${key}" is not an object`);
  }
  const row = value as Record<string, unknown>;
  const rates: Partial<Record<AnalysisLevel, AnalysisPriceRate>> = {};
  for (const level of LEVELS) {
    if (row[level] !== undefined) rates[level] = priceRate(row[level], `${key}.${level}`);
  }
  return rates;
};

export async function analysisPrice(): Promise<AnalysisPrice> {
  const value = await setting(ANALYSIS_PRICE_KEY);
  if (typeof value !== "object" || value === null) {
    throw new Error(`setting "${ANALYSIS_PRICE_KEY}" is not an object`);
  }
  const row = value as Record<string, unknown>;
  return {
    photo: priceKind(row.photo, `${ANALYSIS_PRICE_KEY}.photo`),
    audio: priceKind(row.audio, `${ANALYSIS_PRICE_KEY}.audio`),
    video: priceKind(row.video, `${ANALYSIS_PRICE_KEY}.video`),
  };
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
