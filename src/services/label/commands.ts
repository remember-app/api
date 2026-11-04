import { sql } from "../../integrations/db/index.ts";
import type { LabelId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { Label } from "../../types/label.ts";
import { accessOf, canContribute, type ProjectAccess } from "../project/access.ts";
import { getLabel } from "./queries.ts";

export type LabelDenial = { denial: "not_found" | "forbidden" };

const canEdit = (label: Label, access: ProjectAccess, viewerId: UserId): boolean =>
  label.shared ? canContribute(access) : label.ownerId === viewerId;

async function labelForEdit(
  projectId: ProjectId,
  labelId: LabelId,
  viewerId: UserId,
): Promise<{ label: Label; access: ProjectAccess } | LabelDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  const label = await getLabel(labelId);
  if (!label || label.projectId !== projectId) return { denial: "not_found" };
  if (!canEdit(label, access, viewerId)) return { denial: "forbidden" };
  return { label, access };
}

export type NewLabel = {
  name: string;
  colorHex: `#${string}`;
  description: string | null;
  shared: boolean;
};

export async function createLabel(
  projectId: ProjectId,
  viewerId: UserId,
  input: NewLabel,
): Promise<{ label: Label } | LabelDenial> {
  const access = await accessOf(projectId, viewerId);
  if (!access) return { denial: "not_found" };
  if (input.shared && !canContribute(access)) return { denial: "forbidden" };
  const [row] = await sql<{ id: LabelId }[]>`
    insert into labels (project_id, owner_id, name, color_hex, description, shared)
    values (
      ${projectId},
      ${viewerId},
      ${input.name},
      ${input.colorHex},
      ${input.description},
      ${input.shared}
    )
    returning id
  `;
  if (!row) throw new Error("label insert returned no row");
  const label = await getLabel(row.id);
  if (!label) throw new Error("label insert returned no label");
  return { label };
}

export type LabelPatch = Partial<Pick<Label, "name" | "colorHex" | "description">>;

export async function updateLabel(
  projectId: ProjectId,
  labelId: LabelId,
  viewerId: UserId,
  patch: LabelPatch,
): Promise<{ label: Label } | LabelDenial> {
  const found = await labelForEdit(projectId, labelId, viewerId);
  if ("denial" in found) return found;
  const next = { ...found.label, ...patch };
  await sql`
    update labels
    set name = ${next.name}, color_hex = ${next.colorHex}, description = ${next.description}
    where id = ${labelId} and project_id = ${projectId}
  `;
  const label = await getLabel(labelId);
  if (!label) return { denial: "not_found" };
  return { label };
}

export async function deleteLabel(
  projectId: ProjectId,
  labelId: LabelId,
  viewerId: UserId,
): Promise<{ ok: true } | LabelDenial> {
  const found = await labelForEdit(projectId, labelId, viewerId);
  if ("denial" in found) return found;
  await sql`delete from labels where id = ${labelId} and project_id = ${projectId}`;
  return { ok: true };
}

export async function attachLabels(
  projectId: ProjectId,
  labelId: LabelId,
  viewerId: UserId,
  itemIds: ProjectItemId[],
): Promise<{ attached: number } | LabelDenial> {
  const found = await labelForEdit(projectId, labelId, viewerId);
  if ("denial" in found) return found;
  if (itemIds.length === 0) return { attached: 0 };
  const rows = await sql`
    insert into project_item_labels (project_item_id, label_id)
    select pi.id, l.id
    from project_items pi
    join labels l on l.id = ${labelId} and l.project_id = pi.project_id
    where pi.id = any(${itemIds}) and pi.project_id = ${projectId}
    on conflict do nothing
    returning project_item_id
  `;
  return { attached: rows.length };
}

export async function detachLabels(
  projectId: ProjectId,
  labelId: LabelId,
  viewerId: UserId,
  itemIds: ProjectItemId[],
): Promise<{ detached: number } | LabelDenial> {
  const found = await labelForEdit(projectId, labelId, viewerId);
  if ("denial" in found) return found;
  if (itemIds.length === 0) return { detached: 0 };
  const rows = await sql`
    delete from project_item_labels l
    using project_items pi
    where l.project_item_id = pi.id
      and l.project_item_id = any(${itemIds})
      and l.label_id = ${labelId}
      and pi.project_id = ${projectId}
    returning l.project_item_id
  `;
  return { detached: rows.length };
}
