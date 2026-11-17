import { sql } from "../../integrations/db/index.ts";

export const songColumns = sql`
  id,
  name,
  author,
  media_id as "mediaId",
  cover_id as "coverId",
  description,
  uploaded_by as "uploadedBy",
  analysis
`;
