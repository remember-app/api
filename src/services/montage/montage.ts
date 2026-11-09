import { sql } from "../../integrations/db/index.ts";
import { page } from "../../pagination.ts";
import type { MontageId, MovieId, ProjectId, TemplateId, UserId } from "../../types/id.ts";
import type {
  Montage,
  MontageManifest,
  MontageSetting,
  MontageSource,
  MontageStage,
  MontageStatus,
  MontageTemplate,
} from "../../types/montage.ts";
import { spendProjectTokens, spendUserTokens } from "../consumable/commands.ts";
import { enqueue, liveJobId } from "../queue/commands.ts";
import { analysisPrice } from "../settings/settings.ts";
import { validateOrder } from "./validate.ts";

const columns = sql`
  id,
  project_id as "projectId",
  created_by as "createdBy",
  status,
  manifest,
  created_at as "createdAt",
  error
`;

const viewColumns = sql`
  m.id,
  m.project_id as "projectId",
  m.created_by as "createdBy",
  m.status,
  m.manifest,
  m.created_at as "createdAt",
  m.error,
  mv.id as "movieId"
`;

type MontageRow = Montage & { movieId: MovieId | null };

const stageOf = (montage: Montage): MontageStage => {
  if (montage.status === "queued") return "analysis";
  if (!montage.manifest?.directingInput) return "preparation";
  if (!montage.manifest?.editingParams) return "directing";
  return "editing";
};

export const montageView = (montage: Montage, movieId: MovieId | null = null) => ({
  id: montage.id,
  projectId: montage.projectId,
  createdBy: montage.createdBy,
  status: montage.status,
  stage: stageOf(montage),
  createdAt: montage.createdAt,
  error: montage.error,
  itemIds: montage.manifest?.preparationConfig?.includeItemIds ?? [],
  movieId,
});

export async function getMontage(id: MontageId): Promise<Montage | undefined> {
  const [row] = await sql<Montage[]>`select ${columns} from montages where id = ${id}`;
  return row;
}

export async function getMontageView(id: MontageId) {
  const [row] = await sql<MontageRow[]>`
    select ${viewColumns}
    from montages m left join movies mv on mv.montage_id = m.id
    where m.id = ${id}
  `;
  return row && montageView(row, row.movieId);
}

export async function listMontageViews(projectId: ProjectId, limit: number, offset: number) {
  const rows = await sql<MontageRow[]>`
    select ${viewColumns}
    from montages m left join movies mv on mv.montage_id = m.id
    where m.project_id = ${projectId}
    order by m.created_at desc, m.id
    limit ${limit + 1} offset ${offset}
  `;
  return page(
    rows.map((row) => montageView(row, row.movieId)),
    limit,
    offset,
  );
}

export type MontagePaySource = "project" | "user";

export type NewMontage = {
  projectId: ProjectId;
  createdBy: UserId;
  templateId: TemplateId | null;
  config: MontageSetting & MontageSource;
  payFrom: MontagePaySource;
};

export type CreateMontageResult =
  | { montage: Montage }
  | { denial: "invalid"; problems: string[] }
  | { denial: "insufficient_tokens" };

class InsufficientTokensError extends Error {}

export async function createMontage(input: NewMontage): Promise<CreateMontageResult> {
  const order = await validateOrder(input.projectId, input.config);
  const problems = [...order.problems];
  if (input.templateId !== null && !(await getTemplate(input.templateId))) {
    problems.push(`template ${input.templateId} does not exist`);
  }
  if (problems.length > 0) return { denial: "invalid", problems };

  const price = await analysisPrice();
  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${input.projectId}::text))`;
      const manifest: MontageManifest = {
        preparationConfig: { ...input.config, templateId: input.templateId },
        directingInput: null,
        editingParams: null,
      };
      const [row] = await tx<Montage[]>`
      insert into montages (project_id, created_by, status, manifest)
      values (${input.projectId}, ${input.createdBy}, 'queued', ${sql.json(manifest as never)})
      returning ${columns}
    `;
      if (!row) throw new Error("montage insert returned no row");

      const targets = new Set<string>([
        ...order.items.filter((item) => !item.analyzed).map((item) => item.mediaId),
        ...order.songs.filter((song) => !song.analyzed).map((song) => song.mediaId),
      ]);
      const dependencies: number[] = [];
      let fresh = 0;
      for (const mediaId of targets) {
        const live = await liveJobId("media_analysis", mediaId, tx);
        if (live !== undefined) {
          dependencies.push(live);
          continue;
        }
        dependencies.push(await enqueue("media_analysis", mediaId, tx));
        fresh += 1;
      }
      if (fresh > 0) {
        const total = price.tokens * fresh;
        const paid =
          input.payFrom === "project"
            ? await spendProjectTokens(tx, input.projectId, input.createdBy, total)
            : await spendUserTokens(tx, input.createdBy, total);
        if (!paid) throw new InsufficientTokensError();
      }
      await enqueue("montage", row.id, tx, dependencies.length > 0 ? dependencies : null);
      return { montage: row };
    });
  } catch (error) {
    if (error instanceof InsufficientTokensError) return { denial: "insufficient_tokens" };
    throw error;
  }
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
