import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import { downloadUrl } from "../../integrations/storage/s3.ts";
import type { Cursor, CursorPage } from "../../pagination.ts";
import type { MediaId, ProjectId, ProjectItemId, UserId } from "../../types/id.ts";
import type { MediaCamera, MediaDimension, MediaItem, MediaKind } from "../../types/mediaItem.ts";
import type { ProjectItem, ProjectMediaItemAIAnalysis } from "../../types/project.ts";
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
  const rows = await sql<
    MediaRow[]
  >`select ${mediaColumns} from media_items where id = any(${ids})`;
  return rows.map(toMedia);
}

export type MediaView = {
  id: MediaId;
  kind: MediaKind;
  format: string;
  bytes: string;
  dimensions: MediaDimension | null;
  duration: number | null;
  capturedAt: Date | null;
  place: { latitude: number; longitude: number } | null;
  camera: MediaCamera | null;
  uploadedBy: UserId | null;
};

export type ItemView = {
  item: {
    id: ProjectItemId;
    projectId: ProjectId;
    mediaId: MediaId;
    description: string | null;
    labelIds: string[];
    analysis: ProjectMediaItemAIAnalysis | null;
    createdAt: Date;
  };
  media: MediaView;
  uploader: UserPublic | null;
  links: {
    original: string | null;
    thumbnail: string | null;
    preview: string | null;
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
    format: media.format,
    bytes: String(media.bytes),
    dimensions: "dimensions" in media ? media.dimensions : null,
    duration: "duration" in media ? media.duration : null,
    capturedAt: media.metadata.at,
    place: media.metadata.place
      ? { latitude: media.metadata.place.latitude, longitude: media.metadata.place.longitude }
      : null,
    camera: "camera" in media.metadata ? media.metadata.camera : null,
    uploadedBy: media.uploadedBy,
  };
}

async function itemViews(items: ProjectItem[]): Promise<ItemView[]> {
  const ids = items.flatMap((item) => [
    item.mediaId,
    item.derivedMedia.thumbnailId,
    "previewId" in item.derivedMedia ? item.derivedMedia.previewId : null,
  ]);
  const media = await getMediaMany([...new Set(ids.filter((id): id is MediaId => id !== null))]);
  const byId = new Map(media.map((file) => [file.id, file]));
  const uploaderIds = media.flatMap((file) => (file.uploadedBy ? [file.uploadedBy] : []));
  const uploaders = await getPublicUsers([...new Set(uploaderIds)]);
  const byUser = new Map(uploaders.map((user) => [user.id, user]));
  const ttl = config.media.downloadTtlSeconds();
  return Promise.all(
    items.map(async (item) => {
      const file = byId.get(item.mediaId);
      if (!file) throw new Error(`media ${item.mediaId} is missing for item ${item.id}`);
      const thumbnail = item.derivedMedia.thumbnailId && byId.get(item.derivedMedia.thumbnailId);
      const preview =
        "previewId" in item.derivedMedia && item.derivedMedia.previewId
          ? byId.get(item.derivedMedia.previewId)
          : undefined;
      return {
        item: {
          id: item.id,
          projectId: item.projectId,
          mediaId: item.mediaId,
          description: item.description,
          labelIds: item.labelIds,
          analysis: item.analysis,
          createdAt: item.createdAt,
        },
        media: mediaView(file),
        uploader: file.uploadedBy ? (byUser.get(file.uploadedBy) ?? null) : null,
        links: {
          original: await downloadUrl(file.storageKey, ttl),
          thumbnail: thumbnail ? await downloadUrl(thumbnail.storageKey, ttl) : null,
          preview: preview ? await downloadUrl(preview.storageKey, ttl) : null,
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
    join media_items m on m.id = pi.media_id
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
