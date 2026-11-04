import { sql } from "../../../integrations/db/index.ts";
import { type Cursor, type CursorPage, cursorPage } from "../../../pagination.ts";
import type { MediaId, ProjectId, ProjectItemId } from "../../../types/id.ts";
import type { ProjectItem, ProjectItemCommon } from "../../../types/project.ts";

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
  pi.created_at as "createdAt",
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
    createdAt: common.createdAt,
  };
  if (common.kind === "audio") {
    return { ...base, kind: "audio", derivedMedia: { thumbnailId } };
  }
  return { ...base, kind: common.kind, derivedMedia: { thumbnailId, previewId } };
};

export async function listItems(
  projectId: ProjectId,
  limit: number,
  after: Cursor | null,
): Promise<CursorPage<ProjectItem>> {
  const rows = await sql<ItemRow[]>`
    select ${itemColumns}
    from project_items pi
    where pi.project_id = ${projectId}
      and (
        ${after?.at ?? null}::timestamptz is null
        or (date_trunc('milliseconds', pi.created_at), pi.id)
          > (${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid)
      )
    order by date_trunc('milliseconds', pi.created_at), pi.id
    limit ${limit + 1}
  `;
  return cursorPage(rows.map(toItem), limit, (item) => ({ at: item.createdAt, id: item.id }));
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
