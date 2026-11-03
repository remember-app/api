import type { UserId } from "./id.ts";

export type User = {
  id: UserId;
  username: string | null;
  name: string | null;
  email: string | null;
};

export type UserPublic = Pick<User, "id" | "username" | "name">;
