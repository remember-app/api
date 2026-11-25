import { sql } from "../../integrations/db/index.ts";
import type { MediaId, MontageId, ProjectId, UploadId, UserId } from "../../types/id.ts";
import { deleteMediaRows } from "../media/commands.ts";
import { accessOf, isAdmin } from "./access.ts";

type ProjectCore = {
  id: ProjectId;
  title: string;
  description: string;
  eventStart: Date;
  eventEnd: Date | null;
  createdAt: Date;
};

async function loadCore(id: ProjectId): Promise<ProjectCore | undefined> {
  const [row] = await sql<ProjectCore[]>`
    select
      id,
      title,
      description,
      event_start as "eventStart",
      event_end as "eventEnd",
      created_at as "createdAt"
    from projects
    where id = ${id}
  `;
  return row;
}

export type NewProject = {
  title: string;
  description?: string;
  eventStart: Date;
  eventEnd: Date | null;
  creatorId: UserId;
  storageBytes?: number;
};

export type CreateProjectResult =
  | { id: ProjectId }
  | { denial: "invalid" | "insufficient_storage" };

export async function createProject(input: NewProject): Promise<CreateProjectResult> {
  const storageBytes = input.storageBytes ?? 0;
  if (!Number.isSafeInteger(storageBytes) || storageBytes < 0) {
    return { denial: "invalid" };
  }
  return sql.begin(async (tx) => {
    if (storageBytes > 0) {
      const [user] = await tx<{ available: string }[]>`
        select storage_bytes - storage_spend as available
        from users where id = ${input.creatorId}
        for update
      `;
      if (!user || Number(user.available) < storageBytes) {
        return { denial: "insufficient_storage" } as const;
      }
    }
    const [created] = await tx<{ id: ProjectId }[]>`
      insert into projects (title, description, event_start, event_end, storage_bytes)
      values (
        ${input.title},
        ${input.description ?? ""},
        ${input.eventStart},
        ${input.eventEnd},
        ${storageBytes}
      )
      returning id
    `;
    if (!created) throw new Error("project insert returned no row");
    await tx`
      insert into project_members (project_id, user_id, role, storage_bytes)
      values (${created.id}, ${input.creatorId}, 'admin', ${storageBytes})
    `;
    const [creator] = await tx<{ language: "en" | "ru" }[]>`
      select language from users where id = ${input.creatorId}
    `;
    await tx`
      insert into labels (project_id, owner_id, name, color)
      values (
        ${created.id},
        ${input.creatorId},
        ${creator?.language === "en" ? "Cover" : "Обложка"},
        '#FFB547'
      )
    `;
    if (storageBytes > 0) {
      await tx`
        update users
        set storage_spend = users.storage_spend + ${storageBytes}
        where id = ${input.creatorId}
      `;
    }
    return { id: created.id } as const;
  });
}

export type ProjectPatch = {
  title?: string;
  description?: string;
  eventStart?: Date;
  eventEnd?: Date | null;
};

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
        description = ${next.description},
        event_start = ${next.eventStart},
        event_end = ${next.eventEnd}
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
        select original_id from project_items where project_id = ${id}
        union
        select compressed_id from project_items
          where project_id = ${id} and compressed_id is not null
        union
        select (value)::uuid
        from project_items pi, jsonb_each_text(pi.previews_ids)
        where pi.project_id = ${id}
        union
        select original_id from movies where project_id = ${id}
        union
        select compressed_id from movies
          where project_id = ${id} and compressed_id is not null
        union
        select preview_id from movies where project_id = ${id} and preview_id is not null
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
