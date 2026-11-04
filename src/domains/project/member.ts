import { sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, UserId } from "../../types/id.ts";
import type {
  ProjectContributionStatus,
  ProjectMember,
  ProjectMemberRole,
} from "../../types/project.ts";
import { deleteMediaRows } from "../media/media.ts";

export async function listMembers(projectId: ProjectId): Promise<ProjectMember[]> {
  return sql<ProjectMember[]>`
    select
      user_id as "userId",
      role,
      contribution,
      joined_at as "joinedAt",
      invited_by as "invitedBy"
    from project_members
    where project_id = ${projectId}
    order by joined_at, user_id
  `;
}

export async function addMember(
  projectId: ProjectId,
  userId: UserId,
  role: ProjectMemberRole,
  invitedBy: UserId | null,
): Promise<ProjectMember | undefined> {
  const [member] = await sql<ProjectMember[]>`
    insert into project_members (project_id, user_id, role, invited_by)
    values (${projectId}, ${userId}, ${role}, ${invitedBy})
    on conflict (project_id, user_id) do nothing
    returning
      user_id as "userId",
      role,
      contribution,
      joined_at as "joinedAt",
      invited_by as "invitedBy"
  `;
  return member;
}

export async function setContribution(
  projectId: ProjectId,
  userId: UserId,
  contribution: ProjectContributionStatus,
): Promise<ProjectContributionStatus | undefined> {
  const [row] = await sql<{ contribution: ProjectContributionStatus }[]>`
    update project_members
    set contribution = ${contribution}
    where project_id = ${projectId} and user_id = ${userId}
    returning contribution
  `;
  return row?.contribution;
}

export async function adminOf(projectId: ProjectId): Promise<UserId | undefined> {
  const [row] = await sql<{ userId: UserId }[]>`
    select user_id as "userId"
    from project_members
    where project_id = ${projectId} and role = 'admin'
    order by joined_at
    limit 1
  `;
  return row?.userId;
}

export type RemoveMemberResult =
  | { ok: true; storageKeys: string[] }
  | { denial: "not_found" | "admin" };

export async function removeMember(
  projectId: ProjectId,
  userId: UserId,
  adminId: UserId,
): Promise<RemoveMemberResult> {
  return sql.begin(async (tx) => {
    const [member] = await tx<{ role: ProjectMemberRole }[]>`
      select role from project_members where project_id = ${projectId} and user_id = ${userId}
      for update
    `;
    if (!member) return { denial: "not_found" };
    if (member.role === "admin") return { denial: "admin" };
    const rows = await tx<
      {
        itemId: string;
        mediaId: string;
        thumbnailId: string | null;
        previewId: string | null;
      }[]
    >`
      select
        pi.id as "itemId",
        pi.media_id as "mediaId",
        pi.thumbnail_id as "thumbnailId",
        pi.preview_id as "previewId"
      from project_items pi
      join media_items m on m.id = pi.media_id
      where pi.project_id = ${projectId} and m.uploaded_by = ${userId}
    `;
    const itemIds = rows.map((row) => row.itemId);
    const mediaIds = rows.flatMap((row) => [
      row.mediaId,
      ...(row.thumbnailId ? [row.thumbnailId] : []),
      ...(row.previewId ? [row.previewId] : []),
    ]);
    if (itemIds.length > 0) {
      await tx`delete from project_items where id = any(${itemIds})`;
    }
    const keys = await deleteMediaRows(mediaIds as MediaId[], tx);
    await tx`
      delete from labels
      where project_id = ${projectId} and owner_id = ${userId} and not shared
    `;
    await tx`
      update labels
      set owner_id = ${adminId}
      where project_id = ${projectId} and owner_id = ${userId} and shared
    `;
    await tx`
      delete from project_members where project_id = ${projectId} and user_id = ${userId}
    `;
    return { ok: true, storageKeys: keys };
  });
}
