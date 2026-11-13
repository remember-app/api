import { quoteTokens } from "../../analysis-price.ts";
import { sql } from "../../integrations/db/index.ts";
import { effectiveAnalysisLevel } from "../../levels.ts";
import { page } from "../../pagination.ts";
import type { Page } from "../../types/api.ts";
import type { MediaId, MontageId, ProjectId, TemplateId, UserId } from "../../types/id.ts";
import type { MediaKind } from "../../types/mediaItem.ts";
import type {
  Montage,
  MontageLevel,
  MontageManifest,
  MontageSetting,
  MontageSource,
  MontageStatus,
  MontageTemplate,
} from "../../types/montage.ts";
import type { AnalysisLevel } from "../../types/project.ts";
import { spendProjectTokens, spendUserTokens } from "../consumable/commands.ts";
import { enqueue, liveJobId } from "../queue/commands.ts";
import type { MontagePrice } from "../settings/defaults.ts";
import { analysisLevel, analysisPrice, montageLevel, montagePrice } from "../settings/settings.ts";
import { validateOrder } from "./validate.ts";

const columns = sql`
  id,
  project_id as "projectId",
  created_by as "createdBy",
  status,
  manifest,
  journal,
  created_at as "createdAt",
  error
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
    order by created_at desc, id
    limit ${limit + 1} offset ${offset}
  `;
  return page(rows, limit, offset);
}

export type MontagePaySource = "project" | "user";

export type NewMontage = {
  projectId: ProjectId;
  createdBy: UserId;
  templateId: TemplateId | null;
  config: MontageSetting & MontageSource & { name?: string | null; level?: MontageLevel | null };
  payFrom: MontagePaySource;
};

export type MontagePreview = {
  problems: string[];
  tokens: number;
};

type AnalysisTarget = {
  mediaId: MediaId;
  kind: MediaKind;
  level: AnalysisLevel;
  duration: number | null;
};

export type CreateMontageResult =
  | { montage: Montage }
  | { denial: "invalid"; problems: string[] }
  | { denial: "insufficient_tokens" };

class InsufficientTokensError extends Error {}

const levelProblem = (level: MontageLevel): string | null =>
  level === "low" ? null : `montage level ${level} is not implemented yet; only low is available`;

const montageCost = (price: MontagePrice, level: MontageLevel): number => {
  const tokens = price[level];
  if (tokens === undefined) throw new Error(`montage.price has no rate for ${level}`);
  return tokens;
};

export async function createMontage(input: NewMontage): Promise<CreateMontageResult> {
  const analysisDefault = await analysisLevel();
  const order = await validateOrder(input.projectId, input.config, analysisDefault);
  const problems = [...order.problems];
  if (input.templateId !== null && !(await getTemplate(input.templateId))) {
    problems.push(`template ${input.templateId} does not exist`);
  }
  if (problems.length > 0) return { denial: "invalid", problems };

  const level = input.config.level ?? (await montageLevel());
  const levelIssue = levelProblem(level);
  if (levelIssue !== null) return { denial: "invalid", problems: [levelIssue] };
  const price = await analysisPrice();
  const montageRates = await montagePrice();
  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${input.projectId}::text))`;
      const manifest: MontageManifest = {
        preparationConfig: {
          ...input.config,
          name: input.config.name ?? null,
          templateId: input.templateId,
          level,
        },
        directingInput: null,
        editingParams: null,
      };
      const [row] = await tx<Montage[]>`
      insert into montages (project_id, created_by, status, manifest)
      values (${input.projectId}, ${input.createdBy}, 'queued', ${sql.json(manifest as never)})
      returning ${columns}
    `;
      if (!row) throw new Error("montage insert returned no row");

      const targets = new Map<MediaId, AnalysisTarget>();
      for (const item of order.items) {
        if (!item.analyzed) {
          targets.set(item.mediaId, {
            mediaId: item.mediaId,
            kind: item.kind,
            level: effectiveAnalysisLevel(item.kind, analysisDefault),
            duration: item.duration,
          });
        }
      }
      for (const song of order.songs) {
        if (!song.analyzed) {
          targets.set(song.mediaId, {
            mediaId: song.mediaId,
            kind: "audio",
            level: effectiveAnalysisLevel("audio", analysisDefault),
            duration: song.duration,
          });
        }
      }
      const dependencies: number[] = [];
      const fresh: AnalysisTarget[] = [];
      for (const target of targets.values()) {
        const live = await liveJobId("media_analysis", target.mediaId, tx, target.level);
        if (live !== undefined) {
          dependencies.push(live);
          continue;
        }
        dependencies.push(await enqueue("media_analysis", target.mediaId, tx, null, target.level));
        fresh.push(target);
      }
      const tokens = quoteTokens(price, fresh) + montageCost(montageRates, level);
      if (tokens > 0) {
        const paid =
          input.payFrom === "project"
            ? await spendProjectTokens(tx, input.projectId, input.createdBy, tokens)
            : await spendUserTokens(tx, input.createdBy, tokens);
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

export async function previewMontage(input: {
  projectId: ProjectId;
  templateId: TemplateId | null;
  config: MontageSetting & MontageSource & { level?: MontageLevel | null };
}): Promise<MontagePreview> {
  const level = input.config.level ?? (await montageLevel());
  const levelIssue = levelProblem(level);
  if (levelIssue !== null) return { problems: [levelIssue], tokens: 0 };
  const analysisDefault = await analysisLevel();
  const order = await validateOrder(input.projectId, input.config, analysisDefault);
  const problems = [...order.problems];
  if (input.templateId !== null && !(await getTemplate(input.templateId))) {
    problems.push(`template ${input.templateId} does not exist`);
  }
  if (problems.length > 0) return { problems, tokens: 0 };
  const targets = new Map<MediaId, AnalysisTarget>();
  for (const item of order.items) {
    if (!item.analyzed) {
      targets.set(item.mediaId, {
        mediaId: item.mediaId,
        kind: item.kind,
        level: effectiveAnalysisLevel(item.kind, analysisDefault),
        duration: item.duration,
      });
    }
  }
  for (const song of order.songs) {
    if (!song.analyzed) {
      targets.set(song.mediaId, {
        mediaId: song.mediaId,
        kind: "audio",
        level: effectiveAnalysisLevel("audio", analysisDefault),
        duration: song.duration,
      });
    }
  }
  const fresh: AnalysisTarget[] = [];
  for (const target of targets.values()) {
    if ((await liveJobId("media_analysis", target.mediaId, sql, target.level)) === undefined) {
      fresh.push(target);
    }
  }
  const price = await analysisPrice();
  const montageRates = await montagePrice();
  return { problems: [], tokens: quoteTokens(price, fresh) + montageCost(montageRates, level) };
}

export async function retryMontage(id: MontageId): Promise<Montage | undefined> {
  return sql.begin(async (tx) => {
    const [row] = await tx<Montage[]>`
      update montages set status = 'queued', error = null
      where id = ${id} and status = 'failed'
      returning ${columns}
    `;
    if (!row) return undefined;
    await enqueue("montage", id, tx, null);
    return row;
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

export async function listTemplates(): Promise<MontageTemplate[]> {
  return sql<MontageTemplate[]>`
    select
      id,
      settings,
      cover_id as "coverId",
      about,
      reference_media_id as "referenceMediaId"
    from montage_templates
    order by about -> 'en' ->> 'name'
  `;
}

export async function getTemplate(id: TemplateId): Promise<MontageTemplate | undefined> {
  const [row] = await sql<MontageTemplate[]>`
    select
      id,
      settings,
      cover_id as "coverId",
      about,
      reference_media_id as "referenceMediaId"
    from montage_templates
    where id = ${id}
  `;
  return row;
}
