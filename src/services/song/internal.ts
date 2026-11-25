import { sql } from "../../integrations/db/index.ts";

export const songColumns = sql`
  id,
  name,
  author,
  original_id as "originalId",
  compressed_id as "compressedId",
  cover_id as "coverId",
  preview_cover_id as "previewCoverId",
  uploaded_by as "uploadedBy",
  analysis
`;

export const songSelect = sql`
  s.id,
  s.name,
  s.author,
  s.original_id as "originalId",
  s.compressed_id as "compressedId",
  s.cover_id as "coverId",
  s.preview_cover_id as "previewCoverId",
  s.uploaded_by as "uploadedBy",
  s.analysis,
  nullif(m.meta->>'duration', '')::float8 as "duration"
`;
