import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { Contact } from "../../types/contact.ts";
import type { UserId } from "../../types/id.ts";
import type { UserPublic } from "../../types/user.ts";
import { contactColumns } from "./internal.ts";

export async function listContacts(
  ownerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<Contact>> {
  const rows = await sql<Contact[]>`
    select ${contactColumns}
    from contacts c
    join users u on u.id = c.contact_id
    where c.owner_id = ${ownerId}
    order by coalesce(c.name, u.username), u.id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export async function listSuggestions(
  ownerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<UserPublic>> {
  const rows = await sql<UserPublic[]>`
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
  return page(rows, limit, offset);
}
