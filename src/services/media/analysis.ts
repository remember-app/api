import { quoteTokens } from "../../analysis-price.ts";
import { type Db, sql } from "../../integrations/db/index.ts";
import { analysisSatisfies, effectiveAnalysisLevel } from "../../levels.ts";
import type { MediaId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { MediaKind } from "../../types/mediaItem.ts";
import type { AnalysisLevel } from "../../types/project.ts";
import { spendUserTokens } from "../consumable/commands.ts";
import { accessOf, isAdmin } from "../project/access.ts";
import { enqueue, liveJobId } from "../queue/commands.ts";
import { analysisLevel, analysisPrice } from "../settings/settings.ts";

class InsufficientTokensError extends Error {}

export type AnalyzeResult =
  | { queued: number; tokens: number }
  | { denial: "not_found" | "forbidden" | "insufficient_tokens" };

export type AnalysisJobStatus = "queued" | "running" | "done" | "failed";

export type AnalysisJob = {
  itemId: ProjectItemId;
  mediaId: MediaId;
  kind: MediaKind;
  status: AnalysisJobStatus;
  error: string | null;
  analysis: unknown;
};

export type AnalysisJobsResult = { items: AnalysisJob[] } | { denial: "not_found" | "forbidden" };

type Candidate = {
  mediaId: MediaId;
  kind: MediaKind;
  level: AnalysisLevel;
  duration: number | null;
};

async function freshMedia(
  projectId: ProjectId,
  itemIds: ProjectItemId[],
  db: Db,
  force: boolean,
  level: AnalysisLevel,
): Promise<Candidate[]> {
  const rows = await db<
    { mediaId: MediaId; kind: MediaKind; analysis: unknown; duration: number | null }[]
  >`
    select pi.media_id as "mediaId", pi.kind, pi.analysis, m.duration
    from project_items pi
    join media_items m on m.id = pi.media_id
    where pi.project_id = ${projectId}
      and pi.id = any(${itemIds}::uuid[])
  `;
  const candidates = new Map<MediaId, Candidate>();
  for (const row of rows) {
    const wanted = effectiveAnalysisLevel(row.kind, level);
    if (force || !analysisSatisfies(row.analysis, wanted)) {
      candidates.set(row.mediaId, {
        mediaId: row.mediaId,
        kind: row.kind,
        level: wanted,
        duration: row.duration,
      });
    }
  }
  const fresh: Candidate[] = [];
  for (const candidate of candidates.values()) {
    if ((await liveJobId("media_analysis", candidate.mediaId, db, candidate.level)) === undefined) {
      fresh.push(candidate);
    }
  }
  return fresh;
}

async function accessTo(
  projectId: ProjectId,
  userId: UserId,
): Promise<"ok" | "not_found" | "forbidden"> {
  const access = await accessOf(projectId, userId);
  if (!access) return "not_found";
  return isAdmin(access) ? "ok" : "forbidden";
}

export async function previewAnalysis(
  projectId: ProjectId,
  userId: UserId,
  itemIds: ProjectItemId[],
  force = false,
): Promise<AnalyzeResult> {
  const allowed = await accessTo(projectId, userId);
  if (allowed !== "ok") return { denial: allowed };
  const price = await analysisPrice();
  const fresh = await freshMedia(projectId, itemIds, sql, force, await analysisLevel());
  return { queued: fresh.length, tokens: quoteTokens(price, fresh) };
}

export async function analyzeItems(
  projectId: ProjectId,
  userId: UserId,
  itemIds: ProjectItemId[],
  force = false,
): Promise<AnalyzeResult> {
  const allowed = await accessTo(projectId, userId);
  if (allowed !== "ok") return { denial: allowed };

  const price = await analysisPrice();
  const level = await analysisLevel();
  try {
    return await sql.begin(async (tx): Promise<{ queued: number; tokens: number }> => {
      await tx`select pg_advisory_xact_lock(hashtext(${projectId}::text))`;
      const fresh = await freshMedia(projectId, itemIds, tx, force, level);
      if (force) {
        for (const candidate of fresh) {
          await tx`
            update project_items
            set analysis = null
            where project_id = ${projectId} and media_id = ${candidate.mediaId}
          `;
        }
      }
      for (const candidate of fresh) {
        await enqueue("media_analysis", candidate.mediaId, tx, null, candidate.level);
      }
      const tokens = quoteTokens(price, fresh);
      if (!(await spendUserTokens(tx, userId, tokens))) throw new InsufficientTokensError();
      return { queued: fresh.length, tokens };
    });
  } catch (error) {
    if (error instanceof InsufficientTokensError) return { denial: "insufficient_tokens" };
    throw error;
  }
}

type AnalysisJobRow = {
  itemId: ProjectItemId;
  mediaId: MediaId;
  kind: MediaKind;
  analysis: unknown;
  jobStatus: AnalysisJobStatus | null;
  error: string | null;
};

export async function listAnalysisJobs(
  projectId: ProjectId,
  userId: UserId,
): Promise<AnalysisJobsResult> {
  const allowed = await accessTo(projectId, userId);
  if (allowed !== "ok") return { denial: allowed };
  const level = await analysisLevel();
  const rows = await sql<AnalysisJobRow[]>`
    select
      pi.id as "itemId",
      pi.media_id as "mediaId",
      pi.kind,
      pi.analysis,
      j.status as "jobStatus",
      j.error
    from project_items pi
    left join lateral (
      select status, error, updated_at
      from jobs
      where kind = 'media_analysis' and ref = pi.media_id
      order by id desc
      limit 1
    ) j on true
    where pi.project_id = ${projectId}
      and (pi.analysis is not null or j.status is not null)
    order by coalesce(j.updated_at, pi.created_at) desc
  `;
  const items: AnalysisJob[] = rows.map((row) => {
    const done = analysisSatisfies(row.analysis, effectiveAnalysisLevel(row.kind, level));
    const status: AnalysisJobStatus = done
      ? "done"
      : row.jobStatus === "queued" || row.jobStatus === "running" || row.jobStatus === "failed"
        ? row.jobStatus
        : row.analysis !== null
          ? "done"
          : "queued";
    return {
      itemId: row.itemId,
      mediaId: row.mediaId,
      kind: row.kind,
      status,
      error: row.error,
      analysis: row.analysis,
    };
  });
  return { items };
}
