export type Language = "en" | "ru";

export type ConsumableResponse = {
  tokens: {
    tokens: number;
    spend: number;
  };
  storage: {
    bytes: number;
    spend: number;
  };
};

export type UserResponse = {
  id: string;
  username: string | null;
  name: string | null;
  email: string | null;
  language: Language;
  profileMediaId: string | null;
};

export type PublicUserResponse = {
  id: string;
  username: string | null;
  name: string | null;
  profileMediaId: string | null;
};

export type AccountResponse = UserResponse & {
  consumables: ConsumableResponse;
};

export type UsernameAvailabilityResponse = {
  available: boolean;
};

export type SetUsernameRequest = {
  username: string;
};

export type SetNameRequest = {
  name: string | null;
};

export type SetLanguageRequest = {
  language: Language;
};
