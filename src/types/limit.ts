import type { UserId } from "./id.ts";

export type UserLimit = {
  userId: UserId;
  tokens: number;
  storageBytes: number;
};
