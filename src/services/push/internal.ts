import { sql } from "../../integrations/db/index.ts";

export const tokenColumns = sql`token, user_id as "userId", platform, created_at as "createdAt"`;
