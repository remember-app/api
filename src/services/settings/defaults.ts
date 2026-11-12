export type Reward = { tokens: number; storageBytes: number };

export type InviteRewards = { sender: Reward; invitee: Reward };

export type AnalysisPrice = { tokens: number };

export type AnalysisGradingItem = { points: number; question: string };

export const INVITE_REWARDS_KEY = "invites.rewards";

export const ANALYSIS_PRICE_KEY = "analysis.price";

export const ANALYSIS_GRADING_KEY = "analysis.grading";

export const DEFAULT_ANALYSIS_GRADING: AnalysisGradingItem[] = [
  {
    points: 2,
    question:
      "How significant is this moment for the event, from a passing frame to the key moment?",
  },
  {
    points: 2,
    question:
      "How strong are the emotion and the people in the frame, from empty or backs turned to live faces, laughter or an embrace?",
  },
  {
    points: 2,
    question: "How good is the composition, from a random accidental frame to a clear shot?",
  },
  {
    points: 2,
    question:
      "How good is the technical quality, from blurred, dark or overexposed to sharp and well lit?",
  },
  {
    points: 2,
    question:
      "How well does the frame cut into the movie, from an unusable still to a frame with motion or a strong still that cuts well?",
  },
  {
    points: 5,
    question:
      "Does the uploader's comment name a concrete reason this frame matters? If it does, the frame scores 8.00-10.00 at once, and the comment decides how high.",
  },
  {
    points: 3,
    question:
      "Is this a screenshot, a chat capture, an accidental frame, blurred, dark, overexposed, or a retake of another frame? Such a frame scores 0.00-2.00, and a retake loses at least 2.00 against the best frame of the moment.",
  },
  {
    points: 1,
    question:
      "Is the score supported by what is in the frame or in the uploader's comment, without inflating it?",
  },
];
