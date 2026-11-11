import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSETS,
  type Asset,
  daysAgo,
  type Project,
  patch,
  post,
  type Token,
  tokenOf,
} from "./common.ts";

type UploadPlan = { id: string; parts: string[] };

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
): Promise<{ itemId: string; mediaId: string }> {
  const file = readFileSync(join(ASSETS, "mock", dirOf(asset.file), asset.file));
  const fingerprint = createHash("sha256").update(file).digest("hex");
  const plan = await post<UploadPlan>(`/v1/projects/${projectId}/uploads`, token, {
    kind: asset.kind,
    sizeBytes: file.length,
    fileName: asset.file,
    fingerprint,
    capturedAt: daysAgo(asset.daysAgo).toISOString(),
    ...(asset.durationSeconds === undefined ? {} : { durationSeconds: asset.durationSeconds }),
  });
  const signed = plan.parts[0];
  if (plan.parts.length !== 1 || !signed) {
    throw new Error(`test seed expects one part for ${asset.file}, got ${plan.parts.length}`);
  }
  const url = new URL(signed);
  if (process.env.S3_ENDPOINT) {
    const internal = new URL(process.env.S3_ENDPOINT);
    url.protocol = internal.protocol;
    url.host = internal.host;
  }
  const put = await fetch(url, {
    method: "PUT",
    headers: { "content-type": asset.contentType },
    body: file,
  });
  if (!put.ok) throw new Error(`S3 PUT ${asset.file} → ${put.status} ${await put.text()}`);
  const etag = (put.headers.get("etag") ?? "").replaceAll('"', "");
  if (!etag) throw new Error(`S3 PUT ${asset.file} → no ETag`);
  return post<{ itemId: string; mediaId: string }>(
    `/v1/projects/${projectId}/uploads/${plan.id}/complete`,
    token,
    { parts: [{ part_number: 1, etag }] },
  );
}

export async function seedMedia(
  tokens: Map<string, Token>,
  project: Project,
  projectId: string,
  labelIds: Map<string, string>,
): Promise<string[]> {
  const owner = tokenOf(tokens, project.owner);
  const itemIds: string[] = [];
  for (const asset of project.assets) {
    const uploader = tokenOf(tokens, asset.by ?? project.owner);
    const uploaded = await uploadAsset(uploader, projectId, asset);
    itemIds.push(uploaded.itemId);
    if (asset.kind === "audio") {
      await post(`/v1/projects/${projectId}/songs`, owner, {
        name: asset.description || asset.file,
        author: "Nox",
        mediaId: uploaded.mediaId,
      });
    }
    await patch(`/v1/projects/${projectId}/items/${uploaded.itemId}`, uploader, {
      description: asset.description,
    });
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
