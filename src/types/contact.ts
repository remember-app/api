import type { UserId } from "./id.ts";

export type Contact = {
  ownerId: UserId;
  contactId: UserId;
  name: string | null;
};
