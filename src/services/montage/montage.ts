import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { MontageId, ProjectId, TemplateId, UserId } from "../../types/id.ts";
import type {
  Montage,
  MontageConfig,
  MontageJournalEntry,
  MontageStage,
  MontageStatus,
  MontageTemplate,
} from "../../types/montage.ts";
import { enqueue } from "../queue/commands.ts";
import { validateConfig } from "./validate.ts";

const columns = sql`
  id,
  project_id as "projectId",
  created_by as "createdBy",
  status,
  created_at as "createdAt",
  error,
  template_id as "templateId",
  config
`;

export async function getMontage(id: MontageId): Promise<Montage | undefined> {
  const [row] = await sql<Montage[]>`select ${columns} from montages where id = ${id}`;
  return row;
}

export async function listMontages(
  projectId: ProjectId,
  limit: number,
  offset: number,
): Promise<Page<Montage>> {
  const rows = await sql<Montage[]>`
    select ${columns}
    from montages
    where project_id = ${projectId}
    order by created_at desc
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export type NewMontage = {
  projectId: ProjectId;
  createdBy: UserId;
  templateId: TemplateId | null;
  config: MontageConfig;
};

export type CreateMontageResult = { montage: Montage } | { denial: "invalid"; problems: string[] };

export async function createMontage(input: NewMontage): Promise<CreateMontageResult> {
  const problems = await validateConfig(input.projectId, input.config);
  if (problems.length > 0) return { denial: "invalid", problems };
  return sql.begin(async (tx) => {
    const [row] = await tx<Montage[]>`
      insert into montages (project_id, created_by, status, template_id, config)
      values (
        ${input.projectId}, ${input.createdBy}, 'queued', ${input.templateId},
        ${sql.json(input.config)}
      )
      returning ${columns}
    `;
    if (!row) throw new Error("montage insert returned no row");
    await enqueue("montage", row.id, tx);
    return { montage: row };
  });
}

export async function setMontageStatus(
  id: MontageId,
  status: MontageStatus,
  error: string | null = null,
): Promise<boolean> {
  const rows = await sql`
    update montages set status = ${status}, error = ${error} where id = ${id} returning id
  `;
  return rows.length > 0;
}

export async function addJournalEntry(
  montageId: MontageId,
  stage: MontageStage,
  entry: MontageJournalEntry,
): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into montage_journal_entries (montage_id, stage, entry)
    values (${montageId}, ${stage}, ${sql.json(entry)})
    returning id
  `;
  if (!row) throw new Error("journal insert returned no row");
  return row.id;
}

type JournalRow = {
  id: number;
  stage: MontageStage;
  entry: MontageJournalEntry;
};

export async function listJournal(
  montageId: MontageId,
  limit: number,
  offset: number,
): Promise<Page<{ id: number; stage: MontageStage; entry: MontageJournalEntry }>> {
  const rows = await sql<JournalRow[]>`
    select id, stage, entry
    from montage_journal_entries
    where montage_id = ${montageId}
    order by id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export async function listTemplates(): Promise<MontageTemplate[]> {
  return sql<MontageTemplate[]>`
    select
      id,
      name,
      settings,
      reference_media_id as "referenceMediaId"
    from montage_templates
    order by name
  `;
}

export async function getTemplate(id: TemplateId): Promise<MontageTemplate | undefined> {
  const [row] = await sql<MontageTemplate[]>`
    select id, name, settings, reference_media_id as "referenceMediaId"
    from montage_templates
    where id = ${id}
  `;
  return row;
}
