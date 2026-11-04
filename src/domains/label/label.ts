import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { LabelId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { Label } from "../../types/label.ts";

const columns = sql`
  id,
  project_id as "projectId",
  owner_id as "ownerId",
  name,
  color_hex as "colorHex",
  description,
  shared,
  created_at as "createdAt"
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
): Promise<Page<Label>> {
  const rows = await sql<Label[]>`
    select ${columns}
    from labels
    where project_id = ${projectId} and (shared or owner_id = ${viewerId})
    order by shared desc, name, id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export type NewLabel = {
  projectId: ProjectId;
  ownerId: UserId;
  name: string;
  colorHex: `#${string}`;
  description: string | null;
  shared: boolean;
};

export async function createLabel(input: NewLabel): Promise<Label> {
  const [row] = await sql<Label[]>`
    insert into labels (project_id, owner_id, name, color_hex, description, shared)
    values (
      ${input.projectId},
      ${input.ownerId},
      ${input.name},
      ${input.colorHex},
      ${input.description},
      ${input.shared}
    )
    returning ${columns}
  `;
  if (!row) throw new Error("label insert returned no row");
  return row;
}

export type LabelPatch = Partial<Pick<Label, "name" | "colorHex" | "description">>;

export async function updateLabel(
  id: LabelId,
  projectId: ProjectId,
  patch: LabelPatch,
): Promise<Label | undefined> {
  return sql.begin(async (tx) => {
    const [current] = await tx<Label[]>`
      select ${columns} from labels
      where id = ${id} and project_id = ${projectId}
      for update
    `;
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const [row] = await tx<Label[]>`
      update labels
      set name = ${next.name}, color_hex = ${next.colorHex}, description = ${next.description}
      where id = ${id}
      returning ${columns}
    `;
    return row;
  });
}

export async function deleteLabel(id: LabelId, projectId: ProjectId): Promise<boolean> {
  const rows = await sql`
    delete from labels where id = ${id} and project_id = ${projectId} returning id
  `;
  return rows.length > 0;
}

export async function labelsOfItem(itemId: ProjectItemId): Promise<LabelId[]> {
  const rows = await sql<{ labelId: LabelId }[]>`
    select label_id as "labelId"
    from project_item_labels
    where project_item_id = ${itemId}
    order by label_id
  `;
  return rows.map((row) => row.labelId);
}

export async function attachLabels(
  projectId: ProjectId,
  labelId: LabelId,
  itemIds: ProjectItemId[],
): Promise<number> {
  if (itemIds.length === 0) return 0;
  return sql.begin(async (tx) => {
    const rows = await tx`
      insert into project_item_labels (project_item_id, label_id)
      select pi.id, l.id
      from project_items pi
      join labels l on l.id = ${labelId} and l.project_id = pi.project_id
      where pi.id = any(${itemIds}) and pi.project_id = ${projectId}
      on conflict do nothing
      returning project_item_id
    `;
    return rows.length;
  });
}

export async function detachLabels(
  projectId: ProjectId,
  labelId: LabelId,
  itemIds: ProjectItemId[],
): Promise<number> {
  if (itemIds.length === 0) return 0;
  return sql.begin(async (tx) => {
    const rows = await tx`
      delete from project_item_labels l
      using project_items pi
      where l.project_item_id = pi.id
        and l.project_item_id = any(${itemIds})
        and l.label_id = ${labelId}
        and pi.project_id = ${projectId}
      returning l.project_item_id
    `;
    return rows.length;
  });
}

export async function handOverLabels(
  projectId: ProjectId,
  leaving: UserId,
  adminId: UserId,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      delete from labels
      where project_id = ${projectId} and owner_id = ${leaving} and not shared
    `;
    await tx`
      update labels
      set owner_id = ${adminId}
      where project_id = ${projectId} and owner_id = ${leaving} and shared
    `;
  });
}
