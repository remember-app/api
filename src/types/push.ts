import type { UserId } from "./id.ts";

export type PushToken = {
  token: string;
  userId: UserId;
  platform: PushPlatform;
  createdAt: Date;
};

export type PushPlatform = "ios" | "android";
