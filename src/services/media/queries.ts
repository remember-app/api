import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import { downloadUrl } from "../../integrations/storage/s3.ts";
import type { Cursor, CursorPage } from "../../pagination.ts";
import type { LabelId, MediaId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type {
  MediaCamera,
  MediaDimension,
  MediaItem,
  MediaKind,
  MediaPlace,
} from "../../types/mediaItem.ts";
import type {
  ProjectItem,
  ProjectItemPreviewSizes,
  ProjectMediaItemAIAnalysis,
} from "../../types/project.ts";
import type { UserPublic } from "../../types/user.ts";
import { accessOf } from "../project/access.ts";
import { getItem, listItems } from "../project/item/queries.ts";
import { getPublicUsers } from "../user/queries.ts";
import { type MediaRow, mediaColumns, toMedia } from "./internal.ts";

export async function getMedia(id: MediaId): Promise<MediaItem | undefined> {
  const [row] = await sql<MediaRow[]>`select ${mediaColumns} from media_items where id = ${id}`;
  return row && toMedia(row);
}

export async function getMediaMany(ids: MediaId[]): Promise<MediaItem[]> {
  if (ids.length === 0) return [];
  const rows = await sql<MediaRow[]>`
    select ${mediaColumns} from media_items where id = any(${ids})
  `;
  return rows.map(toMedia);
}

export type MediaMetaView = {
  dimensions: MediaDimension | null;
  duration: number | null;
  at: string | null;
  place: MediaPlace | null;
  camera: MediaCamera | null;
};

export type MediaView = {
  id: MediaId;
  kind: MediaKind;
  fingerprint: string;
  perceptualHash: string;
  format: string;
  bytes: string;
  meta: MediaMetaView;
};

export type ItemView = {
  item: {
    id: ProjectItemId;
    projectId: ProjectId;
    uploadedBy: UserId;
    comment: string | null;
    labelIds: LabelId[];
    analysis: ProjectMediaItemAIAnalysis | null;
    createdAt: Date;
  };
  media: MediaView;
  uploader: UserPublic | null;
  links: {
    original: string | null;
    compressed: string | null;
    previews: Partial<Record<ProjectItemPreviewSizes, string>>;
  };
};

export type DownloadLinkView = {
  itemId: ProjectItemId;
  url: string;
};

export function mediaView(media: MediaItem): MediaView {
  return {
    id: media.id,
    kind: media.kind,
    fingerprint: media.fingerprint,
    perceptualHash: media.perceptualHash,
    format: media.format,
    bytes: String(media.bytes),
    meta: {
      dimensions: media.meta.dimensions,
      duration: media.meta.duration,
      at: media.meta.at?.toISOString() ?? null,
      place: media.meta.place,
      camera: media.meta.camera,
    },
  };
}

async function itemViews(items: ProjectItem[]): Promise<ItemView[]> {
  const ids = items.flatMap((item) => [
    item.originalId,
    item.compressedId,
    ...Object.values(item.previewsIds ?? {}),
  ]);
  const media = await getMediaMany([...new Set(ids.filter((id): id is MediaId => id !== null))]);
  const byId = new Map(media.map((file) => [file.id, file]));
  const uploaders = await getPublicUsers([...new Set(items.map((item) => item.uploadedBy))]);
  const byUser = new Map(uploaders.map((user) => [user.id, user]));
  const ttl = config.media.downloadTtlSeconds();
  return Promise.all(
    items.map(async (item) => {
      const original = byId.get(item.originalId);
      if (!original) throw new Error(`media ${item.originalId} is missing for item ${item.id}`);
      const compressed = item.compressedId ? byId.get(item.compressedId) : undefined;
      const previews: Partial<Record<ProjectItemPreviewSizes, string>> = {};
      if (item.previewsIds) {
        for (const [size, id] of Object.entries(item.previewsIds)) {
          const file = id ? byId.get(id) : undefined;
          if (file) previews[size as ProjectItemPreviewSizes] = await downloadUrl(file.storageKey, ttl);
        }
      }
      return {
        item: {
          id: item.id,
          projectId: item.projectId,
          uploadedBy: item.uploadedBy,
          comment: item.comment,
          labelIds: item.labelIds,
          analysis: item.analysis,
          createdAt: item.createdAt,
        },
        media: mediaView(original),
        uploader: byUser.get(item.uploadedBy) ?? null,
        links: {
          original: await downloadUrl(original.storageKey, ttl),
          compressed: compressed ? await downloadUrl(compressed.storageKey, ttl) : null,
          previews,
        },
      };
    }),
  );
}

export async function galleryPage(
  projectId: ProjectId,
  viewerId: UserId,
  limit: number,
  after: Cursor | null,
): Promise<CursorPage<ItemView> | undefined> {
  if (!(await accessOf(projectId, viewerId))) return undefined;
  const page = await listItems(projectId, limit, after);
  return { items: await itemViews(page.items), nextCursor: page.nextCursor };
}

export async function itemView(
  projectId: ProjectId,
  itemId: ProjectItemId,
  viewerId: UserId,
): Promise<ItemView | undefined> {
  if (!(await accessOf(projectId, viewerId))) return undefined;
  const item = await getItem(projectId, itemId);
  if (!item) return undefined;
  const [view] = await itemViews([item]);
  return view;
}

export async function downloadLinks(
  projectId: ProjectId,
  viewerId: UserId,
  itemIds: ProjectItemId[],
): Promise<DownloadLinkView[] | undefined> {
  if (!(await accessOf(projectId, viewerId))) return undefined;
  if (itemIds.length === 0) return [];
  const rows = await sql<{ itemId: ProjectItemId; key: string }[]>`
    select pi.id as "itemId", m.storage_key as key
    from project_items pi
    join media_items m on m.id = pi.original_id
    where pi.project_id = ${projectId} and pi.id = any(${itemIds})
  `;
  const ttl = config.media.downloadTtlSeconds();
  return Promise.all(
    rows.map(async (row) => ({
      itemId: row.itemId,
      url: await downloadUrl(row.key, ttl),
    })),
  );
}
