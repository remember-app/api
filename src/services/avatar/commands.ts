import { randomUUID } from "node:crypto";
import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import { deleteObjects, downloadUrl, headSize, uploadUrl } from "../../integrations/storage/s3.ts";
import type { MediaId, UserId } from "../../types/id.ts";
import type { MediaPhotoFormat } from "../../types/mediaItem.ts";
import { deleteMediaRows } from "../media/commands.ts";

const formats: Record<string, MediaPhotoFormat> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  heic: "heic",
  webp: "webp",
};

const storageKey = (format: string, id: MediaId) => `remember/${format}/${id}`;

export type AvatarStart = { mediaId: MediaId; url: string } | { denial: "unsupported_format" };

export async function startAvatarUpload(userId: UserId, fileName: string): Promise<AvatarStart> {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const format = formats[extension];
  if (!format) return { denial: "unsupported_format" };
  const mediaId = randomUUID() as MediaId;
  const key = storageKey(format, mediaId);
  await sql`
    insert into media_items (id, kind, storage_key, uploaded_by, format, bytes)
    values (${mediaId}, 'photo', ${key}, ${userId}, ${format}, 0)
  `;
  return { mediaId, url: await uploadUrl(key, config.media.uploadTtlSeconds()) };
}

export type AvatarComplete = { url: string } | { denial: "not_found" | "too_large" };

export async function completeAvatarUpload(
  userId: UserId,
  mediaId: MediaId,
): Promise<AvatarComplete> {
  const [media] = await sql<{ storageKey: string; uploadedBy: UserId | null }[]>`
    select storage_key as "storageKey", uploaded_by as "uploadedBy"
    from media_items where id = ${mediaId}
  `;
  if (!media || media.uploadedBy !== userId) return { denial: "not_found" };
  const bytes = await headSize(media.storageKey);
  if (bytes === null || bytes <= 0) return { denial: "not_found" };
  if (bytes > config.media.maxFileBytes()) {
    await deleteObjects([media.storageKey]);
    await deleteMediaRows([mediaId]);
    return { denial: "too_large" };
  }
  const [user] = await sql<{ profileMediaId: MediaId | null }[]>`
    select profile_media_id as "profileMediaId" from users where id = ${userId}
  `;
  if (!user) return { denial: "not_found" };
  const previousId = user.profileMediaId;
  const [previous] =
    previousId === null
      ? []
      : await sql<{ storageKey: string }[]>`
          select storage_key as "storageKey" from media_items where id = ${previousId}
        `;
  await sql.begin(async (tx) => {
    await tx`update media_items set bytes = ${bytes} where id = ${mediaId}`;
    await tx`update users set profile_media_id = ${mediaId} where id = ${userId}`;
    if (previousId !== null && previousId !== mediaId) {
      await deleteMediaRows([previousId], tx);
    }
  });
  if (previous && previousId !== mediaId) await deleteObjects([previous.storageKey]);
  return { url: await downloadUrl(media.storageKey, config.media.downloadTtlSeconds()) };
}

export async function avatarUrl(userId: UserId): Promise<string | null> {
  const [row] = await sql<{ storageKey: string }[]>`
    select m.storage_key as "storageKey"
    from users u
    join media_items m on m.id = u.profile_media_id
    where u.id = ${userId}
  `;
  return row ? downloadUrl(row.storageKey, config.media.downloadTtlSeconds()) : null;
}

export async function removeAvatar(userId: UserId): Promise<boolean> {
  const [user] = await sql<{ profileMediaId: MediaId | null }[]>`
    select profile_media_id as "profileMediaId" from users where id = ${userId} for update
  `;
  if (!user?.profileMediaId) return false;
  const mediaId = user.profileMediaId;
  const [media] = await sql<{ storageKey: string }[]>`
    select storage_key as "storageKey" from media_items where id = ${mediaId}
  `;
  await sql.begin(async (tx) => {
    await tx`update users set profile_media_id = null where id = ${userId}`;
    await deleteMediaRows([mediaId], tx);
  });
  if (media) await deleteObjects([media.storageKey]);
  return true;
}
