import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { LabelId, ProjectId, UserId } from "../../types/id.ts";
import type { Label } from "../../types/label.ts";
import { accessOf } from "../project/access.ts";

const columns = sql`
  id,
  project_id as "projectId",
  owner_id as "ownerId",
  name,
  color,
  coalesce(
    array(
      select l.project_item_id
      from project_item_labels l
      where l.label_id = labels.id
      order by l.project_item_id
    ),
    '{}'
  ) as "itemsIds"
`;

export async function getLabel(id: LabelId): Promise<Label | undefined> {
  const [row] = await sql<Label[]>`select ${columns} from labels where id = ${id}`;
  return row;
}

export async function listLabels(
  projectId: ProjectId,
  viewerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<Label> | undefined> {
  if (!(await accessOf(projectId, viewerId))) return undefined;
  const rows = await sql<Label[]>`
    select ${columns}
    from labels
    where project_id = ${projectId}
    order by name, id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}
