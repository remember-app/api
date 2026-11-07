import type { PageResponse } from "./common.ts";
import type { UserResponse } from "./user.ts";

export type LoginStartRequest = {
  email: string;
};

export type LoginStartResponse = {
  ok: true;
  registered: boolean;
  code?: string;
};

export type LoginVerifyRequest = {
  email: string;
  code: string;
};

export type LoginResponse = {
  token: string;
  user: UserResponse;
};

export type SessionResponse = {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};

export type SessionsPageResponse = PageResponse<SessionResponse>;
