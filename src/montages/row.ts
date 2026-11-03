import type { Montage } from "../types/montages.ts";

export type { Montage };
export const orientations = ["landscape", "portrait"] as const;
export const templateIds = [
  "for_myself",
  "quick",
  "report",
  "short_form",
  "parents",
  "dopamine",
] as const;
