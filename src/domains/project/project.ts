import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type {
  MediaId,
  MontageId,
  MovieId,
  ProjectId,
  ProjectItemId,
  UploadId,
  UserId,
} from "../../types/id.ts";
import type { Project, ProjectMember } from "../../types/project.ts";
import { deleteMediaRows } from "../media/media.ts";
import { accessOf } from "./access.ts";
import { allMembers } from "./member.ts";

type ProjectCore = Omit<Project, "members" | "itemIds" | "musicIds" | "movieIds">;

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

export async function loadProject(id: ProjectId): Promise<Project | undefined> {
  const core = await loadCore(id);
  if (!core) return undefined;
  const [members, items, songs, movies] = await Promise.all([
    allMembers(id),
    sql<{ id: ProjectItemId }[]>`
      select id from project_items where project_id = ${id} order by created_at, id
    `,
    sql<{ mediaId: MediaId }[]>`
      select media_id as "mediaId" from songs where project_id = ${id}
    `,
    sql<{ id: MovieId }[]>`
      select id from movies where project_id = ${id} order by created_at desc
    `,
  ]);
  return {
    ...core,
    members,
    itemIds: items.map((item) => item.id),
    musicIds: songs.map((song) => song.mediaId),
    movieIds: movies.map((movie) => movie.id),
  };
}

export async function projectTitle(id: ProjectId): Promise<string | undefined> {
  const [row] = await sql<{ title: string }[]>`select title from projects where id = ${id}`;
  return row?.title;
}

export async function getProject(id: ProjectId, viewerId: UserId): Promise<Project | undefined> {
  if (!(await accessOf(id, viewerId))) return undefined;
  return loadProject(id);
}

export async function listProjects(
  viewerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<Project>> {
  const rows = await sql<{ id: ProjectId }[]>`
    select project_id as id from project_members
    where user_id = ${viewerId}
    order by joined_at, project_id
    limit ${limit + 1} offset ${offset}
  `;
  const projects = await Promise.all(rows.map((row) => loadProject(row.id)));
  return page(
    projects.filter((project): project is Project => project !== undefined),
    limit,
    offset,
  );
}

export type NewProject = {
  title: string;
  eventStart: Date;
  eventEnd: Date | null;
  creatorId: UserId;
};

export async function createProject(input: NewProject): Promise<Project> {
  return sql.begin(async (tx) => {
    const [core] = await tx<ProjectCore[]>`
      insert into projects (title, event_start, event_end)
      values (${input.title}, ${input.eventStart}, ${input.eventEnd})
      returning
        id,
        title,
        event_start as "eventStart",
        event_end as "eventEnd",
        created_at as "createdAt",
        cover_item_id as "coverItemId"
    `;
    if (!core) throw new Error("project insert returned no row");
    const [member] = await tx<ProjectMember[]>`
      insert into project_members (project_id, user_id, role)
      values (${core.id}, ${input.creatorId}, 'admin')
      returning
        user_id as "userId",
        role,
        contribution,
        joined_at as "joinedAt",
        invited_by as "invitedBy"
    `;
    if (!member) throw new Error("membership insert returned no row");
    return { ...core, members: [member], itemIds: [], musicIds: [], movieIds: [] };
  });
}

export type ProjectPatch = Partial<
  Pick<Project, "title" | "eventStart" | "eventEnd" | "coverItemId">
>;

export async function updateProject(
  id: ProjectId,
  patch: ProjectPatch,
): Promise<Project | undefined> {
  const core = await loadCore(id);
  if (!core) return undefined;
  const next = { ...core, ...patch };
  await sql`
    update projects
    set title = ${next.title},
        event_start = ${next.eventStart},
        event_end = ${next.eventEnd},
        cover_item_id = ${next.coverItemId}
    where id = ${id}
  `;
  return loadProject(id);
}

export type ProjectDeletion = {
  storageKeys: string[];
  multiparts: { key: string; uploadId: string }[];
};

export async function deleteProject(id: ProjectId): Promise<ProjectDeletion | undefined> {
  return sql.begin(async (tx) => {
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
}
