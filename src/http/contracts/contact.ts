import type { PageResponse } from "./common.ts";
import type { PublicUserResponse } from "./user.ts";

export type ContactResponse = {
  contactId: string;
  username: string | null;
  name: string | null;
};

export type ContactsPageResponse = PageResponse<ContactResponse>;

export type SuggestionsPageResponse = PageResponse<PublicUserResponse>;

export type AddContactRequest = {
  username: string;
  name?: string | null;
};

export type RenameContactRequest = {
  name: string | null;
};
