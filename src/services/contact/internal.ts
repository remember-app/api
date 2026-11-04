import { sql } from "../../integrations/db/index.ts";

export const contactColumns = sql`
  c.owner_id as "ownerId",
  c.contact_id as "contactId",
  c.name,
  u.username
`;
