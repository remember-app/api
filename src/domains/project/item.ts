import { sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, ProjectItemId } from "../../types/id.ts";
import type { ProjectItem, ProjectItemCommon } from "../../types/project.ts";

type ItemRow = ProjectItemCommon & {
  thumbnailId: MediaId | null;
  previewId: MediaId | null;
};

const itemColumns = sql`
  pi.id,
  pi.kind,
  pi.media_id as "mediaId",
  pi.project_id as "projectId",
  pi.description,
  pi.analysis,
  pi.thumbnail_id as "thumbnailId",
  pi.preview_id as "previewId",
  array(
    select l.label_id
    from project_item_labels l
    where l.project_item_id = pi.id
    order by l.label_id
  ) as "labelIds"
`;

const toItem = ({ thumbnailId, previewId, ...common }: ItemRow): ProjectItem => {
  const base = {
    id: common.id,
    mediaId: common.mediaId,
    projectId: common.projectId,
    description: common.description,
    labelIds: common.labelIds,
    analysis: common.analysis,
  };
  if (common.kind === "audio") {
    return { ...base, kind: "audio", derivedMedia: { thumbnailId } };
  }
  return { ...base, kind: common.kind, derivedMedia: { thumbnailId, previewId } };
};

export async function listItems(projectId: ProjectId): Promise<ProjectItem[]> {
  const rows = await sql<ItemRow[]>`
    select ${itemColumns}
    from project_items pi
    where pi.project_id = ${projectId}
    order by pi.created_at, pi.id
  `;
  return rows.map(toItem);
}

export async function getItem(
  projectId: ProjectId,
  itemId: ProjectItemId,
): Promise<ProjectItem | undefined> {
  const [row] = await sql<ItemRow[]>`
    select ${itemColumns}
    from project_items pi
    where pi.project_id = ${projectId} and pi.id = ${itemId}
  `;
  return row && toItem(row);
}

export async function getItemByMedia(
  projectId: ProjectId,
  mediaId: MediaId,
): Promise<ProjectItem | undefined> {
  const [row] = await sql<ItemRow[]>`
    select ${itemColumns}
    from project_items pi
    where pi.project_id = ${projectId} and pi.media_id = ${mediaId}
  `;
  return row && toItem(row);
}

export async function countItems(projectId: ProjectId): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from project_items where project_id = ${projectId}
  `;
  return row?.count ?? 0;
}

export async function createItem(
  projectId: ProjectId,
  mediaId: MediaId,
  kind: ProjectItemCommon["kind"],
): Promise<ProjectItemId> {
  const [row] = await sql<{ id: ProjectItemId }[]>`
    insert into project_items (project_id, media_id, kind)
    values (${projectId}, ${mediaId}, ${kind})
    returning id
  `;
  if (!row) throw new Error("project item insert returned no row");
  return row.id;
}

export async function setItemDescription(
  projectId: ProjectId,
  itemId: ProjectItemId,
  description: string | null,
): Promise<boolean> {
  const rows = await sql`
    update project_items
    set description = ${description}
    where project_id = ${projectId} and id = ${itemId}
    returning id
  `;
  return rows.length > 0;
}

export async function removeItem(projectId: ProjectId, itemId: ProjectItemId): Promise<boolean> {
  const rows = await sql`
    delete from project_items
    where project_id = ${projectId} and id = ${itemId}
    returning id
  `;
  return rows.length > 0;
}
