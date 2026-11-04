import { sql } from "../../../integrations/db/index.ts";
import { page } from "../../../pagination.ts";
import type { Page } from "../../../types/api.ts";
import type { ProjectId } from "../../../types/id.ts";
import type { ProjectMember } from "../../../types/project.ts";

const memberColumns = sql`
  pm.user_id as "userId",
  u.username,
  u.name,
  pm.role,
  pm.contribution,
  pm.joined_at as "joinedAt",
  pm.invited_by as "invitedBy"
`;

export async function allMembers(projectId: ProjectId): Promise<ProjectMember[]> {
  return sql<ProjectMember[]>`
    select ${memberColumns}
    from project_members pm
    join users u on u.id = pm.user_id
    where pm.project_id = ${projectId}
    order by pm.joined_at, pm.user_id
  `;
}

export async function listMembers(
  projectId: ProjectId,
  limit: number,
  offset: number,
): Promise<Page<ProjectMember>> {
  const rows = await sql<ProjectMember[]>`
    select ${memberColumns}
    from project_members pm
    join users u on u.id = pm.user_id
    where pm.project_id = ${projectId}
    order by pm.joined_at, pm.user_id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}
