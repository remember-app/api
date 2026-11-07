import type { MediaId, UserId } from "./id.ts";

export type Language = "en" | "ru";

export type User = {
  id: UserId;
  username: string;
  name: string;
  email: string;
  language: Language;
  registered: boolean;
  profileMediaId: MediaId | null;
};

export type UserPublic = Pick<User, "id" | "username" | "name" | "profileMediaId">;
