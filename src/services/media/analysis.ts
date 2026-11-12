import { type Db, sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { MediaKind } from "../../types/mediaItem.ts";
import { spendUserTokens } from "../consumable/commands.ts";
import { accessOf, isAdmin } from "../project/access.ts";
import { enqueue, liveJobId } from "../queue/commands.ts";
import { analysisPrice } from "../settings/settings.ts";

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

async function freshMedia(
  projectId: ProjectId,
  itemIds: ProjectItemId[],
  db: Db,
): Promise<MediaId[]> {
  const rows = await db<{ mediaId: MediaId; analysis: unknown }[]>`
    select media_id as "mediaId", analysis
    from project_items
    where project_id = ${projectId}
      and id = any(${itemIds}::uuid[])
  `;
  const unanalyzed = new Set(rows.filter((row) => row.analysis === null).map((row) => row.mediaId));
  const fresh: MediaId[] = [];
  for (const mediaId of unanalyzed) {
    if ((await liveJobId("media_analysis", mediaId, db)) === undefined) fresh.push(mediaId);
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
): Promise<AnalyzeResult> {
  const allowed = await accessTo(projectId, userId);
  if (allowed !== "ok") return { denial: allowed };
  const price = await analysisPrice();
  const fresh = await freshMedia(projectId, itemIds, sql);
  return { queued: fresh.length, tokens: price.tokens * fresh.length };
}

export async function analyzeItems(
  projectId: ProjectId,
  userId: UserId,
  itemIds: ProjectItemId[],
): Promise<AnalyzeResult> {
  const allowed = await accessTo(projectId, userId);
  if (allowed !== "ok") return { denial: allowed };

  const price = await analysisPrice();
  try {
    return await sql.begin(async (tx): Promise<{ queued: number; tokens: number }> => {
      await tx`select pg_advisory_xact_lock(hashtext(${projectId}::text))`;
      const fresh = await freshMedia(projectId, itemIds, tx);
      for (const mediaId of fresh) {
        await enqueue("media_analysis", mediaId, tx);
      }
      const tokens = price.tokens * fresh.length;
      if (!(await spendUserTokens(tx, userId, tokens))) throw new InsufficientTokensError();
      return { queued: fresh.length, tokens };
    });
  } catch (error) {
    if (error instanceof InsufficientTokensError) return { denial: "insufficient_tokens" };
    throw error;
  }
}

export async function listAnalysisJobs(
  projectId: ProjectId,
  userId: UserId,
): Promise<AnalysisJobsResult> {
  const allowed = await accessTo(projectId, userId);
  if (allowed !== "ok") return { denial: allowed };
  const items = await sql<AnalysisJob[]>`
    select
      pi.id as "itemId",
      pi.media_id as "mediaId",
      pi.kind,
      case when pi.analysis is not null then 'done' else j.status end as status,
      j.error,
      pi.analysis
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
  return { items };
}
