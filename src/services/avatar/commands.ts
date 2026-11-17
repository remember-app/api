import { config } from "../../config.ts";
import { sql } from "../../integrations/db/index.ts";
import { deleteObjects, downloadUrl } from "../../integrations/storage/s3.ts";
import type { MediaId, UserId } from "../../types/id.ts";
import { adjustUserStorageSpend } from "../consumable/commands.ts";
import { deleteMediaRows } from "../media/commands.ts";
import { avatarUrls } from "./queries.ts";

export type AvatarDenial = { denial: "not_found" | "bad_request" };

export async function setAvatar(
  userId: UserId,
  mediaId: MediaId,
): Promise<{ url: string } | AvatarDenial> {
  const [media] = await sql<
    { kind: string; storageKey: string; bytes: string; uploadedBy: UserId | null }[]
  >`
    select kind, storage_key as "storageKey", bytes, uploaded_by as "uploadedBy"
    from media_items where id = ${mediaId}
  `;
  if (!media || media.uploadedBy !== userId) return { denial: "not_found" };
  if (media.kind !== "photo") return { denial: "bad_request" };
  const [owned] = await sql<{ one: number }[]>`
    select 1 as one from uploads
    where media_id = ${mediaId} and project_id is null and uploaded_by = ${userId}
    limit 1
  `;
  if (!owned) return { denial: "bad_request" };
  const [user] = await sql<{ profileMediaId: MediaId | null }[]>`
    select profile_media_id as "profileMediaId" from users where id = ${userId} for update
  `;
  if (!user) return { denial: "not_found" };
  const previousId = user.profileMediaId;
  if (previousId !== mediaId) {
    const previous =
      previousId === null
        ? []
        : await sql<{ storageKey: string; bytes: string }[]>`
            select storage_key as "storageKey", bytes from media_items where id = ${previousId}
          `;
    await sql.begin(async (tx) => {
      await tx`update users set profile_media_id = ${mediaId} where id = ${userId}`;
      if (previousId !== null) {
        const [origin] = await tx<{ one: number }[]>`
          select 1 as one from uploads
          where media_id = ${previousId} and project_id is null
          limit 1
        `;
        if (origin && previous[0]) {
          await adjustUserStorageSpend(tx, userId, -Number(previous[0].bytes));
        }
        await deleteMediaRows([previousId], tx);
      }
    });
    if (previous[0]) await deleteObjects([previous[0].storageKey]);
  }
  return { url: await downloadUrl(media.storageKey, config.media.downloadTtlSeconds()) };
}

export async function avatarUrl(userId: UserId): Promise<string | null> {
  const urls = await avatarUrls([userId]);
  return urls.get(userId) ?? null;
}

export async function removeAvatar(userId: UserId): Promise<boolean> {
  const [user] = await sql<{ profileMediaId: MediaId | null }[]>`
    select profile_media_id as "profileMediaId" from users where id = ${userId} for update
  `;
  if (!user?.profileMediaId) return false;
  const mediaId = user.profileMediaId;
  const [media] = await sql<{ storageKey: string; bytes: string }[]>`
    select storage_key as "storageKey", bytes from media_items where id = ${mediaId}
  `;
  await sql.begin(async (tx) => {
    await tx`update users set profile_media_id = null where id = ${userId}`;
    if (media) {
      const [origin] = await tx<{ one: number }[]>`
        select 1 as one from uploads
        where media_id = ${mediaId} and project_id is null
        limit 1
      `;
      if (origin) await adjustUserStorageSpend(tx, userId, -Number(media.bytes));
    }
    await deleteMediaRows([mediaId], tx);
  });
  if (media) await deleteObjects([media.storageKey]);
  return true;
}
