import { sql } from "../../integrations/db/index.ts";
import type { ProjectId, UserId } from "../../types/id.ts";
import type { ProjectContributionStatus, ProjectMemberRole } from "../../types/project.ts";

export type ProjectAccess = {
  projectId: ProjectId;
  role: ProjectMemberRole;
  contribution: ProjectContributionStatus;
};

export async function accessOf(
  projectId: ProjectId,
  userId: UserId,
): Promise<ProjectAccess | undefined> {
  const [row] = await sql<ProjectAccess[]>`
    select
      project_id as "projectId",
      role,
      contribution
    from project_members
    where project_id = ${projectId} and user_id = ${userId}
  `;
  return row;
}

export const isAdmin = (access: ProjectAccess | undefined) => access?.role === "admin";

export const canContribute = (access: ProjectAccess | undefined) =>
  access?.role === "admin" || access?.role === "contributor";
