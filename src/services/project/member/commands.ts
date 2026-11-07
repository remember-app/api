import { sql } from "../../../integrations/db/index.ts";
import type { MediaId, ProjectId, UserId } from "../../../types/id.ts";
import type {
  ProjectContributionStatus,
  ProjectMember,
  ProjectMemberRole,
} from "../../../types/project.ts";
import { adjustStorageSpend } from "../../consumable/commands.ts";
import { type ConsumableRow, toConsumable } from "../../consumable/queries.ts";
import { deleteMediaRows } from "../../media/commands.ts";
import { findByUsername } from "../../user/queries.ts";
import { accessOf, canContribute, isAdmin } from "../access.ts";

export type MemberDenial = { denial: "not_found" | "forbidden" | "conflict" };

export async function addMember(
  projectId: ProjectId,
  viewerId: UserId,
  username: string,
  role: ProjectMemberRole,
): Promise<{ member: ProjectMember } | MemberDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (!canContribute(access)) return { denial: "forbidden" };
  if (role === "admin" && !isAdmin(access)) return { denial: "forbidden" };
  const target = await findByUsername(username);
  if (!target) return { denial: "not_found" };
  const [row] = await sql<(Omit<ProjectMember, "consumables"> & ConsumableRow)[]>`
    with member as (
      insert into project_members (project_id, user_id, role, invited_by)
      values (${projectId}, ${target.id}, ${role}, ${viewerId})
      on conflict (project_id, user_id) do nothing
      returning
        user_id, role, contribution,
        tokens, tokens_spend, storage_bytes, storage_spend,
        joined_at, invited_by
    )
    select
      m.user_id as "userId",
      u.username,
      u.name,
      m.role,
      m.contribution,
      m.tokens,
      m.tokens_spend as "tokensSpend",
      m.storage_bytes as "storageBytes",
      m.storage_spend as "storageSpend",
      m.joined_at as "joinedAt",
      m.invited_by as "invitedBy"
    from member m
    join users u on u.id = m.user_id
  `;
  if (!row) return { denial: "conflict" };
  const { tokens, tokensSpend, storageBytes, storageSpend, ...member } = row;
  return {
    member: {
      ...member,
      consumables: toConsumable({ tokens, tokensSpend, storageBytes, storageSpend }),
    },
  };
}

export async function setContribution(
  projectId: ProjectId,
  viewerId: UserId,
  status: ProjectContributionStatus,
): Promise<{ status: ProjectContributionStatus } | MemberDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (access.role === "viewer") return { denial: "forbidden" };
  const [row] = await sql<{ contribution: ProjectContributionStatus }[]>`
    update project_members
    set contribution = ${status}
    where project_id = ${projectId} and user_id = ${viewerId}
    returning contribution
  `;
  if (!row) return { denial: "not_found" };
  return { status: row.contribution };
}

async function adminOf(projectId: ProjectId): Promise<UserId | undefined> {
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
  | { denial: "not_found" | "forbidden" | "conflict" };

export async function removeMember(
  projectId: ProjectId,
  viewerId: UserId,
  targetId: UserId,
): Promise<RemoveMemberResult> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  const self = targetId === viewerId;
  if (!self && !isAdmin(access)) return { denial: "forbidden" };
  if (self && access.role === "admin") return { denial: "conflict" };
  const adminId = await adminOf(projectId);
  if (!adminId) return { denial: "conflict" };
  return sql.begin(async (tx) => {
    const [member] = await tx<{ role: ProjectMemberRole }[]>`
      select role from project_members where project_id = ${projectId} and user_id = ${targetId}
      for update
    `;
    if (!member) return { denial: "not_found" };
    if (member.role === "admin") return { denial: "conflict" };
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
      where pi.project_id = ${projectId} and m.uploaded_by = ${targetId}
    `;
    const itemIds = rows.map((row) => row.itemId);
    const mediaIds = rows.flatMap((row) => [
      row.mediaId,
      ...(row.thumbnailId ? [row.thumbnailId] : []),
      ...(row.previewId ? [row.previewId] : []),
    ]);
    if (itemIds.length > 0) {
      const [spent] = await tx<{ bytes: string }[]>`
        select coalesce(sum(bytes), 0)::text as bytes
        from media_items
        where id = any(${mediaIds}) and parent_media_id is null and uploaded_by = ${targetId}
      `;
      if (spent && Number(spent.bytes) > 0) {
        await adjustStorageSpend(tx, projectId, targetId, -Number(spent.bytes));
      }
      await tx`delete from project_items where id = any(${itemIds})`;
    }
    await tx`
      delete from jobs
      where ref = any(${mediaIds})
         or ref in (select id from uploads where media_id = any(${mediaIds}))
    `;
    const keys = await deleteMediaRows(mediaIds as MediaId[], tx);
    await tx`
      delete from labels
      where project_id = ${projectId} and owner_id = ${targetId} and not shared
    `;
    await tx`
      update labels
      set owner_id = ${adminId}
      where project_id = ${projectId} and owner_id = ${targetId} and shared
    `;
    await tx`
      delete from project_members where project_id = ${projectId} and user_id = ${targetId}
    `;
    return { ok: true, storageKeys: keys };
  });
}
