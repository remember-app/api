import { sql } from "../../integrations/db/index.ts";
import type { MediaId, MovieId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { Project, ProjectMember } from "../../types/project.ts";
import { accessOf } from "./access.ts";
import { listMembers } from "./member.ts";

type ProjectCore = Omit<Project, "members" | "mediaItemIds" | "musicIds" | "movieIds">;

async function loadCore(id: ProjectId): Promise<ProjectCore | undefined> {
  const [row] = await sql<ProjectCore[]>`
    select
      id,
      title,
      event_start as "eventStart",
      event_end as "eventEnd",
      created_at as "createdAt",
      cover_item_id as "coverMediaId"
    from projects
    where id = ${id}
  `;
  return row;
}

export async function loadProject(id: ProjectId): Promise<Project | undefined> {
  const core = await loadCore(id);
  if (!core) return undefined;
  const [members, items, songs, movies] = await Promise.all([
    listMembers(id),
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
    mediaItemIds: items.map((item) => item.id),
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

export async function listProjects(viewerId: UserId): Promise<Project[]> {
  const rows = await sql<{ id: ProjectId }[]>`
    select project_id as id from project_members where user_id = ${viewerId}
  `;
  const projects = await Promise.all(rows.map((row) => loadProject(row.id)));
  return projects.filter((project) => project !== undefined);
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
        cover_item_id as "coverMediaId"
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
    return { ...core, members: [member], mediaItemIds: [], musicIds: [], movieIds: [] };
  });
}

export type ProjectPatch = Partial<
  Pick<Project, "title" | "eventStart" | "eventEnd" | "coverMediaId">
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
        cover_item_id = ${next.coverMediaId}
    where id = ${id}
  `;
  return loadProject(id);
}

export async function deleteProject(id: ProjectId): Promise<boolean> {
  const rows = await sql`delete from projects where id = ${id} returning id`;
  return rows.length > 0;
}
