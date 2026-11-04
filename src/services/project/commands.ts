import { sql } from "../../integrations/db/index.ts";
import type { MediaId, MontageId, ProjectId, UploadId, UserId } from "../../types/id.ts";
import type { Project } from "../../types/project.ts";
import { deleteMediaRows } from "../media/commands.ts";
import { accessOf, isAdmin } from "./access.ts";

type ProjectCore = {
  id: ProjectId;
  title: string;
  eventStart: Date;
  eventEnd: Date | null;
  createdAt: Date;
  coverItemId: Project["coverItemId"];
};

async function loadCore(id: ProjectId): Promise<ProjectCore | undefined> {
  const [row] = await sql<ProjectCore[]>`
    select
      id,
      title,
      event_start as "eventStart",
      event_end as "eventEnd",
      created_at as "createdAt",
      cover_item_id as "coverItemId"
    from projects
    where id = ${id}
  `;
  return row;
}

export type NewProject = {
  title: string;
  eventStart: Date;
  eventEnd: Date | null;
  creatorId: UserId;
};

export async function createProject(input: NewProject): Promise<ProjectId> {
  return sql.begin(async (tx) => {
    const [created] = await tx<{ id: ProjectId }[]>`
      insert into projects (title, event_start, event_end)
      values (${input.title}, ${input.eventStart}, ${input.eventEnd})
      returning id
    `;
    if (!created) throw new Error("project insert returned no row");
    await tx`
      insert into project_members (project_id, user_id, role)
      values (${created.id}, ${input.creatorId}, 'admin')
    `;
    return created.id;
  });
}

export type ProjectPatch = Partial<
  Pick<Project, "title" | "eventStart" | "eventEnd" | "coverItemId">
>;

export type Denial = { denial: "not_found" | "forbidden" };

export async function updateProject(
  id: ProjectId,
  viewerId: UserId,
  patch: ProjectPatch,
): Promise<{ ok: true } | Denial> {
  const access = await accessOf(id, viewerId);
  if (!access) return { denial: "not_found" };
  if (!isAdmin(access)) return { denial: "forbidden" };
  const core = await loadCore(id);
  if (!core) return { denial: "not_found" };
  const next = { ...core, ...patch };
  await sql`
    update projects
    set title = ${next.title},
        event_start = ${next.eventStart},
        event_end = ${next.eventEnd},
        cover_item_id = ${next.coverItemId}
    where id = ${id}
  `;
  return { ok: true };
}

export type ProjectDeletion = {
  storageKeys: string[];
  multiparts: { key: string; uploadId: string }[];
};

export async function deleteProject(
  id: ProjectId,
  viewerId: UserId,
): Promise<{ ok: true; deletion: ProjectDeletion } | Denial> {
  const access = await accessOf(id, viewerId);
  if (!access) return { denial: "not_found" };
  if (!isAdmin(access)) return { denial: "forbidden" };
  const deletion = await sql.begin(async (tx) => {
    const media = await tx<{ id: MediaId; storageKey: string }[]>`
      select id, storage_key as "storageKey"
      from media_items
      where id in (
        select media_id from project_items where project_id = ${id}
        union
        select thumbnail_id from project_items
          where project_id = ${id} and thumbnail_id is not null
        union
        select preview_id from project_items
          where project_id = ${id} and preview_id is not null
        union
        select video_id from movies where project_id = ${id}
        union
        select thumbnail_id from movies where project_id = ${id} and thumbnail_id is not null
        union
        select preview_id from movies where project_id = ${id} and preview_id is not null
        union
        select media_id from songs where project_id = ${id}
      )
    `;
    const pending = await tx<{ storageKey: string; multipartId: string | null }[]>`
      select storage_key as "storageKey", multipart_id as "multipartId"
      from uploads
      where project_id = ${id} and status in ('pending', 'uploading')
    `;
    const montageIds = await tx<{ id: MontageId }[]>`
      select id from montages where project_id = ${id}
    `;
    const uploadIds = await tx<{ id: UploadId }[]>`
      select id from uploads where project_id = ${id}
    `;
    const gone = await tx<{ id: ProjectId }[]>`
      delete from projects where id = ${id} returning id
    `;
    if (gone.length === 0) return undefined;
    const refs = [
      ...media.map((row) => row.id),
      ...montageIds.map((row) => row.id),
      ...uploadIds.map((row) => row.id),
    ];
    const keys = await deleteMediaRows(
      media.map((row) => row.id),
      tx,
    );
    if (refs.length > 0) await tx`delete from jobs where ref = any(${refs})`;
    return {
      storageKeys: [...keys, ...pending.map((row) => row.storageKey)],
      multiparts: pending.flatMap((row) =>
        row.multipartId === null ? [] : [{ key: row.storageKey, uploadId: row.multipartId }],
      ),
    };
  });
  if (!deletion) return { denial: "not_found" };
  return { ok: true, deletion };
}
