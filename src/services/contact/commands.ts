import { sql } from "../../integrations/db/index.ts";
import type { Contact } from "../../types/contact.ts";
import type { UserId } from "../../types/id.ts";
import { findByUsername } from "../user/queries.ts";
import { contactColumns } from "./internal.ts";

export type ContactDenial = { denial: "not_found" | "bad_request" };

export async function addContact(
  ownerId: UserId,
  username: string,
  name: string | null,
): Promise<{ contact: Contact } | ContactDenial> {
  const target = await findByUsername(username);
  if (!target) return { denial: "not_found" };
  if (target.id === ownerId) return { denial: "bad_request" };
  const [row] = await sql<Contact[]>`
    with contact as (
      insert into contacts (owner_id, contact_id, name)
      values (${ownerId}, ${target.id}, ${name})
      on conflict (owner_id, contact_id) do update set name = contacts.name
      returning owner_id, contact_id, name
    )
    select ${contactColumns}
    from contact c
    join users u on u.id = c.contact_id
  `;
  if (!row) throw new Error("contact insert returned no row");
  return { contact: row };
}

export async function renameContact(
  ownerId: UserId,
  contactId: UserId,
  name: string | null,
): Promise<Contact | undefined> {
  const [row] = await sql<Contact[]>`
    with contact as (
      update contacts set name = ${name}
      where owner_id = ${ownerId} and contact_id = ${contactId}
      returning owner_id, contact_id, name
    )
    select ${contactColumns}
    from contact c
    join users u on u.id = c.contact_id
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
