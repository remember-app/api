import type { SessionId, UserId } from "./id.ts";

export type AuthSession = {
  id: SessionId;
  userId: UserId;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type AuthIdentity = {
  provider: AuthProvider;
  providerAccountId: string;
  userId: UserId;
  createdAt: Date;
};

export type AuthLoginCode = {
  userId: UserId;
  createdAt: Date;
  expiresAt: Date;
  attemptsLeft: number;
};

export type AuthProvider = "email";
