import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { Contact } from "../../types/contact.ts";
import type { UserId } from "../../types/id.ts";
import type { UserPublic } from "../../types/user.ts";
import { avatarUrls } from "../avatar/queries.ts";
import { contactColumns } from "./internal.ts";

type ContactRow = Omit<Contact, "avatarUrl">;
type PublicRow = Omit<UserPublic, "avatarUrl">;

export async function listContacts(
  ownerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<Contact>> {
  const rows = await sql<ContactRow[]>`
    select ${contactColumns}
    from contacts c
    join users u on u.id = c.contact_id
    where c.owner_id = ${ownerId}
    order by coalesce(c.name, u.username), u.id
    limit ${limit + 1} offset ${offset}
  `;
  const avatars = await avatarUrls(rows.map((row) => row.contactId));
  return page(
    rows.map((row) => ({ ...row, avatarUrl: avatars.get(row.contactId) ?? null })),
    limit,
    offset,
  );
}

export async function listSuggestions(
  ownerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<UserPublic>> {
  const rows = await sql<PublicRow[]>`
    select distinct
      u.id,
      u.username,
      u.name,
      u.profile_media_id as "profileMediaId"
    from project_members mine
    join project_members other on other.project_id = mine.project_id
    join users u on u.id = other.user_id
    where mine.user_id = ${ownerId}
      and other.user_id <> ${ownerId}
      and u.username is not null
    order by u.username, u.id
    limit ${limit + 1} offset ${offset}
  `;
  const avatars = await avatarUrls(rows.map((row) => row.id));
  return page(
    rows.map((row) => ({ ...row, avatarUrl: avatars.get(row.id) ?? null })),
    limit,
    offset,
  );
}
