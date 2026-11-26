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
  ProjectItemPreviews,
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
  variants: {
    original: MediaId;
    compressed: MediaId | null;
    previews: ProjectItemPreviews;
  };
  links: {
    small: string | null;
    middle: string | null;
  };
};

export type ItemLinkVariant = "large" | "detail" | "playback" | "original";

export type ItemLinkRequest = {
  itemId: ProjectItemId;
  variant: ItemLinkVariant;
};

export type ItemLinkView = {
  itemId: ProjectItemId;
  variant: ItemLinkVariant;
  url: string;
  expiresAt: string;
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
      const previews: ProjectItemPreviews = {};
      const links: ItemView["links"] = { small: null, middle: null };
      for (const size of ["small", "middle", "large"] as const) {
        const id = item.previewsIds?.[size];
        const file = id ? byId.get(id) : undefined;
        if (!id || !file) continue;
        previews[size] = id;
        if (size !== "large") links[size] = await downloadUrl(file.storageKey, ttl);
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
        variants: {
          original: item.originalId,
          compressed:
            item.compressedId && byId.has(item.compressedId) ? item.compressedId : null,
          previews,
        },
        links,
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

export async function itemLinks(
  projectId: ProjectId,
  viewerId: UserId,
  requests: ItemLinkRequest[],
): Promise<ItemLinkView[] | undefined> {
  if (!(await accessOf(projectId, viewerId))) return undefined;
  if (requests.length === 0) return [];
  const itemIds = [...new Set(requests.map((request) => request.itemId))];
  const rows = await sql<
    {
      itemId: ProjectItemId;
      kind: MediaKind;
      originalKey: string;
      compressedKey: string | null;
      largeKey: string | null;
    }[]
  >`
    select
      pi.id as "itemId",
      original.kind,
      original.storage_key as "originalKey",
      compressed.storage_key as "compressedKey",
      preview.storage_key as "largeKey"
    from project_items pi
    join media_items original on original.id = pi.original_id
    left join media_items compressed on compressed.id = pi.compressed_id
    left join media_items preview on preview.id = (pi.previews_ids ->> 'large')::uuid
    where pi.project_id = ${projectId} and pi.id = any(${itemIds})
  `;
  const byId = new Map(rows.map((row) => [row.itemId, row]));
  const ttl = config.media.downloadTtlSeconds();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const links = await Promise.all(
    requests.map(async ({ itemId, variant }) => {
      const row = byId.get(itemId);
      if (!row) return undefined;
      if (variant === "detail" && row.kind !== "photo") return undefined;
      if (variant === "playback" && row.kind === "photo") return undefined;
      const key =
        variant === "original"
          ? row.originalKey
          : variant === "large"
            ? row.largeKey
            : row.compressedKey;
      if (!key) return undefined;
      return { itemId, variant, url: await downloadUrl(key, ttl), expiresAt };
    }),
  );
  return links.filter((link): link is ItemLinkView => link !== undefined);
}
