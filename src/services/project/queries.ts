import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import { downloadUrl } from "../../integrations/storage/s3.ts";
import type { Page } from "../../types/api.ts";
import type { Consumable } from "../../types/consumables.ts";
import type { ProjectId, SongId, UserId } from "../../types/id.ts";
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

export type ProjectMemberFace = {
  userId: UserId;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
};

export type ProjectCardView = {
  id: ProjectId;
  title: string;
  description: string;
  eventStart: Date;
  eventEnd: Date | null;
  consumables: Consumable;
  previewUrls: string[];
  songIds: SongId[];
  members: ProjectMemberFace[];
  itemCount: number;
  memberCount: number;
  sharedCount: number;
  myRole: ProjectMemberRole;
  myContribution: ProjectContributionStatus;
};

type MemberFaceRow = Omit<ProjectMemberFace, "avatarUrl"> & { avatarKey: string | null };

type CardRow = Omit<ProjectCardView, "consumables" | "previewUrls" | "members"> &
  ConsumableRow & { previewKeys: string[]; memberFaces: MemberFaceRow[] };

export async function homeCards(
  viewerId: UserId,
  limit: number,
  offset: number,
): Promise<Page<ProjectCardView>> {
  const rows = await sql<CardRow[]>`
    select
      p.id,
      p.title,
      p.description,
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
      coalesce(
        (
          select array_agg(ps.song_id order by ps.added_at, ps.song_id)
          from project_songs ps
          where ps.project_id = p.id
        ),
        '{}'
      ) as "songIds",
      coalesce(previews.keys, '{}') as "previewKeys",
      coalesce(faces.faces, '[]'::json) as "memberFaces"
    from projects p
    join project_members pm on pm.project_id = p.id and pm.user_id = ${viewerId}
    left join lateral (
      select array_agg(key) as keys
      from (
        select m.storage_key as key
        from project_items ci
        join media_items m on m.id = (ci.previews_ids ->> 'small')::uuid
        where ci.project_id = p.id
        order by ci.created_at desc
        limit 4
      ) recent
    ) previews on true
    left join lateral (
      select json_agg(
        json_build_object(
          'userId', u.id,
          'name', u.name,
          'username', u.username,
          'avatarKey', avatar.storage_key
        ) order by earliest.joined_at, earliest.user_id
      ) as faces
      from (
        select pm2.user_id, pm2.joined_at
        from project_members pm2
        where pm2.project_id = p.id
        order by pm2.joined_at, pm2.user_id
        limit 7
      ) earliest
      join users u on u.id = earliest.user_id
      left join media_items avatar on avatar.id = u.profile_media_id
    ) faces on true
    order by pm.joined_at, p.id
    limit ${limit + 1} offset ${offset}
  `;
  const ttl = config.media.downloadTtlSeconds();
  const items = await Promise.all(
    rows.slice(0, limit).map(async (row) => {
      const { previewKeys, memberFaces, tokens, tokensSpend, storageBytes, storageSpend, ...card } =
        row;
      return {
        ...card,
        consumables: toConsumable({ tokens, tokensSpend, storageBytes, storageSpend }),
        previewUrls: await Promise.all(previewKeys.map((key) => downloadUrl(key, ttl))),
        members: await Promise.all(
          memberFaces.map(async ({ avatarKey, ...face }) => ({
            ...face,
            avatarUrl: avatarKey ? await downloadUrl(avatarKey, ttl) : null,
          })),
        ),
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
      p.description,
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
      coalesce(
        (
          select array_agg(ps.song_id order by ps.added_at, ps.song_id)
          from project_songs ps
          where ps.project_id = p.id
        ),
        '{}'
      ) as "songIds"
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
