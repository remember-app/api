import { sql } from "../../integrations/db/index.ts";
import type { MediaId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import { spendUserTokens } from "../consumable/commands.ts";
import { accessOf, isAdmin } from "../project/access.ts";
import { enqueue, liveJobId } from "../queue/commands.ts";
import { analysisPrice } from "../settings/settings.ts";

class InsufficientTokensError extends Error {}

export type AnalyzeResult =
  | { queued: number; tokens: number }
  | { denial: "not_found" | "forbidden" | "insufficient_tokens" };

export async function analyzeItems(
  projectId: ProjectId,
  userId: UserId,
  itemIds: ProjectItemId[],
): Promise<AnalyzeResult> {
  const access = await accessOf(projectId, userId);
  if (!access) return { denial: "not_found" };
  if (!isAdmin(access)) return { denial: "forbidden" };

  const price = await analysisPrice();
  try {
    return await sql.begin(async (tx): Promise<{ queued: number; tokens: number }> => {
      const rows = await tx<{ mediaId: MediaId; analysis: unknown }[]>`
        select media_id as "mediaId", analysis
        from project_items
        where project_id = ${projectId}
          and id = any(${itemIds}::uuid[])
      `;
      const targets = new Set(
        rows.filter((row) => row.analysis === null).map((row) => row.mediaId),
      );
      let queued = 0;
      for (const mediaId of targets) {
        if ((await liveJobId("media_analysis", mediaId, tx)) !== undefined) continue;
        await enqueue("media_analysis", mediaId, tx);
        queued += 1;
      }
      const tokens = price.tokens * queued;
      if (!(await spendUserTokens(tx, userId, tokens))) throw new InsufficientTokensError();
      return { queued, tokens };
    });
  } catch (error) {
    if (error instanceof InsufficientTokensError) return { denial: "insufficient_tokens" };
    throw error;
  }
}
