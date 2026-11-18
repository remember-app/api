import { type Db, sql } from "../../../integrations/db/index.ts";
import type { MediaId, ProjectId, ProjectItemId, UserId } from "../../../types/id.ts";
import type { ProjectItem } from "../../../types/project.ts";
import { accessOf, canContribute } from "../access.ts";

export async function createItem(
  projectId: ProjectId,
  originalId: MediaId,
  kind: ProjectItem["kind"],
  uploadedBy: UserId,
  db: Db = sql,
): Promise<ProjectItemId> {
  const [row] = await db<{ id: ProjectItemId }[]>`
    insert into project_items (project_id, original_id, kind, uploaded_by)
    values (${projectId}, ${originalId}, ${kind}, ${uploadedBy})
    returning id
  `;
  if (!row) throw new Error("project item insert returned no row");
  return row.id;
}

export type ItemDenial = { denial: "not_found" | "forbidden" };

export async function updateItemComment(
  projectId: ProjectId,
  itemId: ProjectItemId,
  viewerId: UserId,
  comment: string | null,
): Promise<{ ok: true } | ItemDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (!canContribute(access)) return { denial: "forbidden" };
  const rows = await sql`
    update project_items
    set comment = ${comment}
    where project_id = ${projectId} and id = ${itemId}
    returning id
  `;
  if (rows.length === 0) return { denial: "not_found" };
  return { ok: true };
}
