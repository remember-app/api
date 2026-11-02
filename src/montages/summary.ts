import type { Order } from "./order.ts";

const secondsPerFrame = 3;
const secondsPerRenderedSecond = 1.5;
export const estimateSeconds = (frames: number, targetSeconds: number) =>
  frames * secondsPerFrame + targetSeconds * secondsPerRenderedSecond;
export const estimateMinutes = (frames: number, targetSeconds: number) =>
  Math.max(1, Math.ceil(estimateSeconds(frames, targetSeconds) / 60));
export const orderSummary = ({ params, left }: Order) => ({
  photos: left.photos,
  videos: left.videos,
  people: left.people,
  min_seconds: left.min_seconds,
  max_seconds: left.max_seconds,
  target_seconds: params.target_seconds,
  orientation: params.orientation ?? "landscape",
  estimate_minutes: estimateMinutes(left.ready, params.target_seconds),
});
