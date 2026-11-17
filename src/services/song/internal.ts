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

export const songSelect = sql`
  s.id,
  s.name,
  s.author,
  s.media_id as "mediaId",
  s.cover_id as "coverId",
  s.description,
  s.uploaded_by as "uploadedBy",
  s.analysis,
  m.duration
`;
