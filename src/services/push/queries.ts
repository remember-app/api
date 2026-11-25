import { sql } from "../../integrations/db/index.ts";
import type { ProjectId, UserId } from "../../types/id.ts";
import type { PushToken } from "../../types/push.ts";
import { tokenColumns } from "./internal.ts";

export async function tokensOfUser(userId: UserId): Promise<PushToken[]> {
  return sql<PushToken[]>`select ${tokenColumns} from push_tokens where user_id = ${userId}`;
}

export async function tokensOfProject(projectId: ProjectId): Promise<PushToken[]> {
  return sql<PushToken[]>`
    select pt.token, pt.user_id as "userId", pt.platform, pt.created_at as "createdAt"
    from push_tokens pt
    join project_members pm on pm.user_id = pt.user_id
    where pm.project_id = ${projectId}
  `;
}
