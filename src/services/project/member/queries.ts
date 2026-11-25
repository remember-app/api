import { type Db, sql } from "../../../integrations/db/index.ts";
import { page } from "../../../pagination.ts";
import type { Page } from "../../../types/api.ts";
import type { ProjectId, UserId } from "../../../types/id.ts";
import type { ProjectMember } from "../../../types/project.ts";
import { avatarUrls } from "../../avatar/queries.ts";
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

type MemberRow = Omit<ProjectMember, "consumables" | "avatarUrl"> & ConsumableRow;

export function toMember(row: MemberRow, avatarUrl: string | null): ProjectMember {
  const { tokens, tokensSpend, storageBytes, storageSpend, ...member } = row;
  return {
    ...member,
    avatarUrl,
    consumables: toConsumable({ tokens, tokensSpend, storageBytes, storageSpend }),
  };
}

export async function memberOf(
  projectId: ProjectId,
  userId: UserId,
  db: Db = sql,
): Promise<ProjectMember | undefined> {
  const [row] = await db<MemberRow[]>`
    select ${memberColumns}
    from project_members pm
    join users u on u.id = pm.user_id
    where pm.project_id = ${projectId} and pm.user_id = ${userId}
  `;
  if (!row) return undefined;
  const avatars = await avatarUrls([row.userId]);
  return toMember(row, avatars.get(row.userId) ?? null);
}

export async function allMembers(projectId: ProjectId): Promise<ProjectMember[]> {
  const rows = await sql<MemberRow[]>`
    select ${memberColumns}
    from project_members pm
    join users u on u.id = pm.user_id
    where pm.project_id = ${projectId}
    order by pm.joined_at, pm.user_id
  `;
  const avatars = await avatarUrls(rows.map((row) => row.userId));
  return rows.map((row) => toMember(row, avatars.get(row.userId) ?? null));
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
  const avatars = await avatarUrls(rows.map((row) => row.userId));
  return page(
    rows.map((row) => toMember(row, avatars.get(row.userId) ?? null)),
    limit,
    offset,
  );
}
