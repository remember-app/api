import type { MediaId, UserId } from "./id.ts";

export type Language = "en" | "ru";

export type User = {
  id: UserId;
  username: string | null;
  name: string | null;
  email: string | null;
  language: Language;
  profileMediaId: MediaId | null;
};

export type UserPublic = Pick<User, "id" | "username" | "name" | "profileMediaId">;
