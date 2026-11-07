import { sql } from "../../../integrations/db/index.ts";
import { page } from "../../../pagination.ts";
import type { Page } from "../../../types/api.ts";
import type { ProjectId } from "../../../types/id.ts";
import type { ProjectMember } from "../../../types/project.ts";
import { type ConsumableRow, toConsumable } from "../../consumable/queries.ts";

const memberColumns = sql`
  pm.user_id as "userId",
  u.username,
  u.name,
  pm.role,
  pm.contribution,
  pm.tokens,
  pm.tokens_spend as "tokensSpend",
  pm.storage_bytes as "storageBytes",
  pm.storage_spend as "storageSpend",
  pm.joined_at as "joinedAt",
  pm.invited_by as "invitedBy"
`;

type MemberRow = Omit<ProjectMember, "consumables"> & ConsumableRow;

export function toMember(row: MemberRow): ProjectMember {
  const { tokens, tokensSpend, storageBytes, storageSpend, ...member } = row;
  return {
    ...member,
    consumables: toConsumable({ tokens, tokensSpend, storageBytes, storageSpend }),
  };
}

export async function allMembers(projectId: ProjectId): Promise<ProjectMember[]> {
  const rows = await sql<MemberRow[]>`
    select ${memberColumns}
    from project_members pm
    join users u on u.id = pm.user_id
    where pm.project_id = ${projectId}
    order by pm.joined_at, pm.user_id
  `;
  return rows.map(toMember);
}

export async function listMembers(
  projectId: ProjectId,
  limit: number,
  offset: number,
): Promise<Page<ProjectMember>> {
  const rows = await sql<MemberRow[]>`
    select ${memberColumns}
    from project_members pm
    join users u on u.id = pm.user_id
    where pm.project_id = ${projectId}
    order by pm.joined_at, pm.user_id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows.map(toMember), limit, offset);
}
