import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Asset, daysAgo, type Project, patch, post, type Token, tokenOf } from "./common.ts";

type UploadPlan = { id: string; partBytes: number; parts: string[] };

const dirOf = (file: string): string =>
  /\.(mp4|mov|m4v)$/i.test(file)
    ? "video"
    : /\.(mp3|m4a|wav|aac|flac|ogg)$/i.test(file)
      ? "audio"
      : "photos";

async function uploadAsset(
  token: Token,
  projectId: string,
  asset: Asset,
  assetsDir: string,
): Promise<{ itemId: string; mediaId: string }> {
  const file = readFileSync(join(assetsDir, dirOf(asset.file), asset.file));
  const fingerprint = createHash("sha256").update(file).digest("hex");
  const plan = await post<UploadPlan>(`/v1/projects/${projectId}/uploads`, token, {
    kind: asset.kind,
    sizeBytes: file.length,
    fileName: asset.file,
    fingerprint,
    capturedAt: (asset.capturedAt ?? daysAgo(asset.daysAgo ?? 0)).toISOString(),
    ...(asset.durationSeconds === undefined ? {} : { durationSeconds: asset.durationSeconds }),
  });
  const parts: { part_number: number; etag: string }[] = [];
  for (let index = 0; index < plan.parts.length; index += 1) {
    const signed = plan.parts[index];
    if (!signed) throw new Error(`test seed: no link for part ${index + 1} of ${asset.file}`);
    const url = new URL(signed);
    if (process.env.S3_ENDPOINT) {
      const internal = new URL(process.env.S3_ENDPOINT);
      url.protocol = internal.protocol;
      url.host = internal.host;
    }
    const start = index * plan.partBytes;
    const put = await fetch(url, {
      method: "PUT",
      headers: { "content-type": asset.contentType },
      body: file.subarray(start, start + plan.partBytes),
    });
    if (!put.ok) throw new Error(`S3 PUT ${asset.file} → ${put.status} ${await put.text()}`);
    const etag = (put.headers.get("etag") ?? "").replaceAll('"', "");
    if (!etag) throw new Error(`S3 PUT ${asset.file} → no ETag`);
    parts.push({ part_number: index + 1, etag });
  }
  return post<{ itemId: string; mediaId: string }>(
    `/v1/projects/${projectId}/uploads/${plan.id}/complete`,
    token,
    { parts },
  );
}

export async function seedMedia(
  tokens: Map<string, Token>,
  project: Project,
  projectId: string,
  labelIds: Map<string, string>,
  assetsDir: string,
): Promise<string[]> {
  const owner = tokenOf(tokens, project.owner);
  const itemIds: string[] = [];
  for (const asset of project.assets) {
    const uploader = tokenOf(tokens, asset.by ?? project.owner);
    const uploaded = await uploadAsset(uploader, projectId, asset, assetsDir);
    itemIds.push(uploaded.itemId);
    if (asset.kind === "audio") {
      await post(`/v1/projects/${projectId}/songs`, owner, {
        name: asset.description || asset.file,
        author: "Nox",
        mediaId: uploaded.mediaId,
      });
    }
    if (asset.description) {
      await patch(`/v1/projects/${projectId}/items/${uploaded.itemId}`, uploader, {
        description: asset.description,
      });
    }
    if (asset.place) {
      await patch(`/v1/projects/${projectId}/media/${uploaded.mediaId}`, uploader, {
        latitude: asset.place.latitude,
        longitude: asset.place.longitude,
      });
    }
    for (const name of asset.labels) {
      const labelId = labelIds.get(name);
      if (!labelId) throw new Error(`test seed: unknown label ${name}`);
      await post(`/v1/projects/${projectId}/labels/${labelId}/items`, owner, {
        itemIds: [uploaded.itemId],
      });
    }
  }
  return itemIds;
}
