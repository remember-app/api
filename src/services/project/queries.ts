import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import { downloadUrl } from "../../integrations/storage/s3.ts";
import type { Page } from "../../types/api.ts";
import type { Consumable } from "../../types/consumables.ts";
import type { ProjectId, UserId } from "../../types/id.ts";
import type { ProjectContributionStatus, ProjectMemberRole } from "../../types/project.ts";

type ConsumableRow = {
  tokens: string;
  tokensSpend: string;
  storageBytes: string;
  storageSpend: string;
};

const consumableColumns = sql`
  p.tokens,
  p.tokens_spend as "tokensSpend",
  p.storage_bytes as "storageBytes",
  p.storage_spend as "storageSpend"
`;

function toConsumable(row: ConsumableRow): Consumable {
  return {
    tokens: { tokens: Number(row.tokens), spend: Number(row.tokensSpend) },
    storage: { bytes: Number(row.storageBytes), spend: Number(row.storageSpend) },
  };
}

export type ProjectCardView = {
  id: ProjectId;
  title: string;
  eventStart: Date;
  eventEnd: Date | null;
  consumables: Consumable;
  previewUrls: string[];
  itemCount: number;
  memberCount: number;
  sharedCount: number;
  myRole: ProjectMemberRole;
  myContribution: ProjectContributionStatus;
};

type CardRow = Omit<ProjectCardView, "consumables" | "previewUrls"> &
  ConsumableRow & { previewKeys: string[] };

export async function homeCards(
  viewerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<ProjectCardView>> {
  const rows = await sql<CardRow[]>`
    select
      p.id,
      p.title,
      p.event_start as "eventStart",
      p.event_end as "eventEnd",
      ${consumableColumns},
      pm.role as "myRole",
      pm.contribution as "myContribution",
      (
        select count(*)::int from project_items pi where pi.project_id = p.id
      ) as "itemCount",
      (
        select count(*)::int from project_members m where m.project_id = p.id
      ) as "memberCount",
      (
        select count(*)::int
        from project_members m
        where m.project_id = p.id and m.contribution = 'done'
      ) as "sharedCount",
      coalesce(previews.keys, '{}') as "previewKeys"
    from projects p
    join project_members pm on pm.project_id = p.id and pm.user_id = ${viewerId}
    left join lateral (
      select array_agg(key) as keys
      from (
        select m.storage_key as key
        from project_items ci
        join media_items m on m.id = ci.thumbnail_id
        where ci.project_id = p.id
        order by ci.created_at desc
        limit 4
      ) recent
    ) previews on true
    order by pm.joined_at, p.id
    limit ${limit + 1} offset ${offset}
  `;
  const ttl = config.media.downloadTtlSeconds();
  const items = await Promise.all(
    rows.slice(0, limit).map(async (row) => {
      const { previewKeys, tokens, tokensSpend, storageBytes, storageSpend, ...card } = row;
      return {
        ...card,
        consumables: toConsumable({ tokens, tokensSpend, storageBytes, storageSpend }),
        previewUrls: await Promise.all(previewKeys.map((key) => downloadUrl(key, ttl))),
      };
    }),
  );
  return { items, nextOffset: rows.length > limit ? offset + limit : null };
}

export type ProjectView = Omit<ProjectCardView, "previewUrls">;

type ProjectRow = Omit<ProjectView, "consumables"> & ConsumableRow;

export async function projectView(
  projectId: ProjectId,
  viewerId: UserId,
): Promise<ProjectView | undefined> {
  const [row] = await sql<ProjectRow[]>`
    select
      p.id,
      p.title,
      p.event_start as "eventStart",
      p.event_end as "eventEnd",
      ${consumableColumns},
      pm.role as "myRole",
      pm.contribution as "myContribution",
      (
        select count(*)::int from project_items pi where pi.project_id = p.id
      ) as "itemCount",
      (
        select count(*)::int from project_members m where m.project_id = p.id
      ) as "memberCount",
      (
        select count(*)::int
        from project_members m
        where m.project_id = p.id and m.contribution = 'done'
      ) as "sharedCount"
    from projects p
    join project_members pm on pm.project_id = p.id and pm.user_id = ${viewerId}
    where p.id = ${projectId}
  `;
  if (!row) return undefined;
  const { tokens, tokensSpend, storageBytes, storageSpend, ...view } = row;
  return {
    ...view,
    consumables: toConsumable({ tokens, tokensSpend, storageBytes, storageSpend }),
  };
}

export async function projectTitle(id: ProjectId): Promise<string | undefined> {
  const [row] = await sql<{ title: string }[]>`select title from projects where id = ${id}`;
  return row?.title;
}
