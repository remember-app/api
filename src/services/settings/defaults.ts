import type { MontageLevel } from "../../types/montage.ts";
import type { AnalysisLevel } from "../../types/project.ts";

export type Reward = { tokens: number; storageBytes: number };

export type InviteRewards = { sender: Reward; invitee: Reward };

export type AnalysisPriceRate =
  | { unit: "file"; tokens: number }
  | { unit: "second"; tokens: number }
  | { unit: "frame"; tokens: number };

export type AnalysisPrice = {
  photo: Partial<Record<AnalysisLevel, AnalysisPriceRate>>;
  audio: Partial<Record<AnalysisLevel, AnalysisPriceRate>>;
  video: Partial<Record<AnalysisLevel, AnalysisPriceRate>>;
};

export type MontagePrice = Partial<Record<MontageLevel, number>>;

export const INVITE_REWARDS_KEY = "invites.rewards";

export const ANALYSIS_PRICE_KEY = "analysis.price";

export const ANALYSIS_GRADING_IMPORTANCE_KEY = "analysis.grading.importance";

export const ANALYSIS_GRADING_QUALITY_KEY = "analysis.grading.quality";

export const MUSIC_GRADING_KEY = "music.grading";

export const ANALYSIS_LEVEL_KEY = "analysis.level";

export const MONTAGE_LEVEL_KEY = "montage.level";

export const MONTAGE_PRICE_KEY = "montage.price";

export const DEFAULT_ANALYSIS_LEVEL: AnalysisLevel = "medium";

export const DEFAULT_MONTAGE_LEVEL: MontageLevel = "low";

export const DEFAULT_MONTAGE_PRICE: MontagePrice = { low: 5 };

export const DEFAULT_ANALYSIS_PRICE: AnalysisPrice = {
  photo: { high: { unit: "file", tokens: 1 } },
  audio: { high: { unit: "second", tokens: 0.01 } },
  video: {
    low: { unit: "frame", tokens: 1 },
    medium: { unit: "second", tokens: 0.25 },
  },
};

export const DEFAULT_ANALYSIS_GRADING_IMPORTANCE = `Score importance from 0.00 to 10.00 with two decimal places. Importance is how much this file matters for the movie of this memory — not how good it looks.

The uploader wrote about this file: {comment}

Calibrate: 0.00-2.00 is a passage between moments; 3.00-5.00 is part of the event but not of its story; 6.00-7.00 is clearly about the memory; 8.00-10.00 is a moment the movie is built around. A concrete reason in the uploader's comment lifts the file towards the upper bands; the comment never raises the quality score.`;

export const DEFAULT_ANALYSIS_GRADING_QUALITY = `Score quality from 0.00 to 10.00 with two decimal places. Quality is how good this segment works as a shot or a recording in the movie — not how much it matters for the memory, and not what the uploader wrote.

Calibrate: 0.00-2.00 cannot be used — blurred, dark, shaking, clipped, or the subject is lost; 3.00-5.00 usable but weak — passable light, loose framing, some noise or clutter; 6.00-7.00 a good shot — clear subject, decent light and framing, clean sound; 8.00-10.00 an excellent shot that carries attention by itself.`;

export const DEFAULT_MUSIC_GRADING = `Score the track from 0.00 to 10.00 with two decimal places. The score is how useful the track is as soundtrack material for a movie about an event — not how good the song is on its own.

Calibrate: 0.00-2.00 unusable as a soundtrack — muddy, clipping, no structure; 3.00-5.00 usable with effort — one mood, little development, or vocals crowding the footage; 6.00-7.00 a good track — fits the mood, cuts well, leaves room for live sound; 8.00-10.00 carries the movie — strong mood, clear sections, sits under speech.`;
