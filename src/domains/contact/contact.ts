import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { Contact } from "../../types/contact.ts";
import type { UserId } from "../../types/id.ts";

export type ContactListItem = Contact & {
  username: string | null;
};

const columns = sql`owner_id as "ownerId", contact_id as "contactId", name`;

export async function listContacts(
  ownerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<ContactListItem>> {
  const rows = await sql<ContactListItem[]>`
    select ${columns}, u.username
    from contacts c
    join users u on u.id = c.contact_id
    where c.owner_id = ${ownerId}
    order by coalesce(c.name, u.username), u.id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export async function findContact(
  ownerId: UserId,
  contactId: UserId,
): Promise<Contact | undefined> {
  const [row] = await sql<Contact[]>`
    select ${columns}
    from contacts
    where owner_id = ${ownerId} and contact_id = ${contactId}
  `;
  return row;
}

export async function addContact(
  ownerId: UserId,
  contactId: UserId,
  name: string | null,
): Promise<Contact> {
  if (ownerId === contactId) throw new Error("a contact cannot be oneself");
  const [row] = await sql<Contact[]>`
    insert into contacts (owner_id, contact_id, name)
    values (${ownerId}, ${contactId}, ${name})
    on conflict (owner_id, contact_id) do update set name = contacts.name
    returning ${columns}
  `;
  if (!row) throw new Error("contact insert returned no row");
  return row;
}

export async function renameContact(
  ownerId: UserId,
  contactId: UserId,
  name: string | null,
): Promise<Contact | undefined> {
  const [row] = await sql<Contact[]>`
    update contacts set name = ${name}
    where owner_id = ${ownerId} and contact_id = ${contactId}
    returning ${columns}
  `;
  return row;
}

export async function removeContact(ownerId: UserId, contactId: UserId): Promise<boolean> {
  const rows = await sql`
    delete from contacts
    where owner_id = ${ownerId} and contact_id = ${contactId}
    returning contact_id
  `;
  return rows.length > 0;
}
