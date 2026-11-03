import type { FastifyInstance } from "fastify";
import { positive } from "../auth/config.ts";
import { sql } from "../db.ts";
import { downloadTtlSeconds } from "../media/config.ts";
import { downloadUrl, storageConfigured } from "../media/r2.ts";
import { seenBy, uuidPattern } from "../memories/plugin.ts";
export const montageStages = ["prep", "analysis", "directing", "music", "assembly"] as const;
type StageKey = (typeof montageStages)[number];

import type { StageRow } from "../types/montages.ts";

export type { StageRow };

type State = StageRow["state"];
type EntryRow = {
  id: string;
  stage: StageKey;
  media_id: string | null;
  thought: string | null;
  decision: "take" | "skip" | null;
  reason: string | null;
  series_size: number | null;
  story_part: number | null;
  story_part_title: string | null;
  source_from_seconds: number | null;
  source_to_seconds: number | null;
  labels: string[] | null;
  details: Record<string, unknown> | null;
  focus_x: number | null;
  focus_y: number | null;
  focus_w: number | null;
  focus_h: number | null;
  created_at: Date;
};
const viewerWindowSeconds = () => positive("MONTAGE_VIEWER_WINDOW_SECONDS", 20);
const defaultLimit = 200;
const maxLimit = 500;
const view = ({ focus_x, focus_y, focus_w, focus_h, id, ...entry }: EntryRow) => ({
  ...entry,
  id: Number(id),
  focus: focus_x === null ? null : { x: focus_x, y: focus_y, w: focus_w, h: focus_h },
});
export async function stagesFor(montageIds: string[]) {
  if (montageIds.length === 0)
    return new Map<
      string,
      {
        stage: StageKey;
        state: State;
      }[]
    >();
  const rows = await sql<
    ({
      montage_id: string;
    } & Pick<StageRow, "stage" | "state">)[]
  >`
    select montage_id, stage, state from montage_stages where montage_id in ${sql(montageIds)}
  `;
  const byMontage = new Map<string, Map<StageKey, State>>();
  for (const row of rows) {
    const states = byMontage.get(row.montage_id) ?? new Map<StageKey, State>();
    states.set(row.stage, row.state);
    byMontage.set(row.montage_id, states);
  }
  return new Map(
    [...byMontage].map(([montageId, states]) => [
      montageId,
      montageStages.map((stage) => ({ stage, state: states.get(stage) ?? "pending" })),
    ]),
  );
}
export function journalRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const query = {
    type: "object",
    additionalProperties: false,
    properties: {
      after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      before: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      limit: { type: "integer", minimum: 1, maximum: maxLimit, default: defaultLimit },
      stage: { type: "string", enum: [...montageStages] },
      media_id: { type: "string", pattern: uuidPattern.source },
    },
  } as const;
  app.get<{
    Params: {
      memoryId: string;
      montageId: string;
    };
    Querystring: {
      after?: number;
      before?: number;
      limit: number;
      stage?: StageKey;
      media_id?: string;
    };
  }>(
    "/memories/:memoryId/montages/:montageId/journal",
    { preHandler: [app.authenticate, app.requireMembership], schema: { querystring: query } },
    async (request, reply) => {
      const { memory } = request.membership;
      const { montageId } = request.params;
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);
      const [montage] = await sql<
        {
          id: string;
          status: string;
        }[]
      >`
        select id, status from montages
        where id = ${montageId} and memory_id = ${memory.id}
      `;
      if (!montage) return reply.code(404).send(notFound);
      const live = montage.status === "queued" || montage.status === "processing";
      if (live) {
        await sql`
          insert into montage_viewers (montage_id, user_id)
          values (${montage.id}, ${request.user.id})
          on conflict (montage_id, user_id) do update set last_seen_at = now()
        `;
      }
      const { after, before, limit, stage, media_id } = request.query;
      const forward = after !== undefined;
      const [stages, rows, viewers] = await Promise.all([
        sql<StageRow[]>`
          with counted as (
            select stage, decision, reason, story_part, count(*)::int as n
            from montage_journal_entries
            where montage_id = ${montage.id}
            group by stage, decision, reason, story_part
          )
          select s.stage, s.state, s.started_at, s.finished_at, s.eta_seconds,
            s.done_count, s.total_count, s.outcome, s.updated_at,
            (select coalesce(sum(n), 0)::int from counted c
              where c.stage = s.stage and c.decision = 'take') as taken_count,
            (select coalesce(sum(n), 0)::int from counted c
              where c.stage = s.stage and c.decision = 'skip') as skipped_count,
            (select coalesce(sum(n), 0)::int from counted c
              where c.stage = s.stage and c.decision is null) as thought_count,
            (select coalesce(jsonb_object_agg(reason, n), '{}') from (
              select reason, sum(n)::int as n from counted c
              where c.stage = s.stage and c.decision = 'skip' and c.reason is not null
              group by reason
            ) r) as skipped_by_reason,
            (select coalesce(jsonb_object_agg(story_part, n), '{}') from (
              select story_part, sum(n)::int as n from counted c
              where c.stage = s.stage and c.decision = 'take' and c.story_part is not null
              group by story_part
            ) p) as taken_by_part
          from montage_stages s
          where s.montage_id = ${montage.id}
        `,
        sql<EntryRow[]>`
          select id, stage, media_id, thought, decision, reason, series_size, story_part,
            story_part_title, source_from_seconds, source_to_seconds, labels, details,
            focus_x, focus_y, focus_w, focus_h, created_at
          from montage_journal_entries
          where montage_id = ${montage.id}
            and (${after ?? null}::bigint is null or id > ${after ?? null}::bigint)
            and (${before ?? null}::bigint is null or id < ${before ?? null}::bigint)
            and (${stage ?? null}::text is null or stage = ${stage ?? null}::text)
            and (${media_id ?? null}::uuid is null or media_id = ${media_id ?? null}::uuid)
          order by id ${forward ? sql`asc` : sql`desc`}
          limit ${limit + 1}
        `,
        sql<
          {
            id: string;
            username: string | null;
          }[]
        >`
          select u.id, u.username from montage_viewers v
          join users u on u.id = v.user_id
          where v.montage_id = ${montage.id}
            and v.last_seen_at > now() - make_interval(secs => ${viewerWindowSeconds()})
          order by v.last_seen_at desc
        `,
      ]);
      const has_more = rows.length > limit;
      const page = has_more ? rows.slice(0, limit) : rows;
      const entries = forward ? page.reverse() : page;
      const mediaIds = [...new Set(entries.map((e) => e.media_id).filter((id) => id !== null))];
      const seen = seenBy("media_items", request.user.id);
      type File = {
        id: string;
        kind: "photo" | "video";
        file_name: string | null;
        uploaded_by: string | null;
        captured_at: Date | null;
        duration_seconds: number | null;
        thumbnail_key: string | null;
      };
      type Place = {
        media_id: string;
        start_seconds: number;
        duration_seconds: number;
      };
      const [media, places]: [File[], Place[]] =
        mediaIds.length > 0
          ? await Promise.all([
              sql<File[]>`
                select id, kind, case when ${seen} then file_name end as file_name,
                  case when ${seen} then uploaded_by end as uploaded_by,
                  captured_at, duration_seconds,
                  case when ${seen} then thumbnail_key end as thumbnail_key
                from media_items
                where memory_id = ${memory.id} and id in ${sql(mediaIds)}
              `,
              sql<Place[]>`
                select media_id, start_seconds, duration_seconds
                from montage_frames
                where montage_id = ${montage.id} and media_id in ${sql(mediaIds)}
                order by start_seconds
              `,
            ])
          : [[], []];
      const ttl = downloadTtlSeconds();
      const configured = storageConfigured();
      const files = await Promise.all(
        media.map(async ({ thumbnail_key, ...file }) => ({
          ...file,
          thumbnail_url: configured && thumbnail_key ? await downloadUrl(thumbnail_key, ttl) : null,
          places: places
            .filter((place) => place.media_id === file.id)
            .map(({ start_seconds, duration_seconds }) => ({ start_seconds, duration_seconds })),
          comments: [],
        })),
      );
      return {
        montage,
        stages: stages.sort(
          (a, b) => montageStages.indexOf(a.stage) - montageStages.indexOf(b.stage),
        ),
        entries: entries.map(view),
        has_more,
        files,
        viewers,
      };
    },
  );
}
