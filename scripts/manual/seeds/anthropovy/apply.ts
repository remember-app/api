import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../../../src/integrations/db/index.ts";
import { putObject } from "../../../../src/integrations/storage/s3.ts";
import type { UploadedMedia } from "../upload.ts";
import { ANTHROPOVY_ASSETS } from "./index.ts";
import snapshotFile from "./snapshot.json" with { type: "json" };

type MovieMedia = {
  id: string;
  parentMediaId: string | null;
  storageKey: string;
  kind: "photo" | "video" | "audio";
  format: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  createdAt: string;
};

type Snapshot = {
  project: { createdAt: string };
  items: {
    file: string;
    itemId: string;
    mediaId: string;
    description: string | null;
    analysis: unknown;
    createdAt: string;
  }[];
  analysisJobs: {
    file: string;
    status: string;
    error: string | null;
    runAfter: string;
    createdAt: string;
    updatedAt: string;
  }[];
  aiRequests: {
    file: string | null;
    montage: boolean;
    operation: string;
    provider: string;
    model: string;
    status: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
    duration: number | null;
    costUsd: string | null;
    error: string | null;
    createdAt: string;
  }[];
  montage: {
    id: string;
    status: string;
    error: string | null;
    createdAt: string;
    manifest: unknown;
    journal: unknown;
    job: {
      status: string;
      error: string | null;
      runAfter: string;
      createdAt: string;
      updatedAt: string;
    };
  };
  movie: {
    id: string;
    name: string;
    createdAt: string;
    media: Record<"video" | "thumbnail" | "preview", MovieMedia>;
  } | null;
};

const snapshot = snapshotFile as Snapshot;
const movie = snapshot.movie;

const MOVIE_FILES = {
  video: { file: "video.mp4", contentType: "video/mp4" },
  thumbnail: { file: "thumbnail.jpg", contentType: "image/jpeg" },
  preview: { file: "preview.mp4", contentType: "video/mp4" },
} as const;

const PARTS = ["video", "thumbnail", "preview"] as const;

const timestamps = (): number[] =>
  [
    snapshot.project.createdAt,
    ...snapshot.items.map((item) => item.createdAt),
    ...snapshot.analysisJobs.flatMap((job) => [job.runAfter, job.createdAt, job.updatedAt]),
    ...snapshot.aiRequests.map((request) => request.createdAt),
    snapshot.montage.createdAt,
    snapshot.montage.job.runAfter,
    snapshot.montage.job.createdAt,
    snapshot.montage.job.updatedAt,
    ...(movie ? [movie.createdAt, ...PARTS.map((part) => movie.media[part].createdAt)] : []),
  ].map((value) => Date.parse(value));

// Seeded rows keep the order they had in the real trail, but the trail now
// ends right now, so a fresh seed never shows a montage finished before its
// own project.
const shift = Date.now() - 1000 - Math.max(...timestamps());

const at = (value: string): Date => new Date(Date.parse(value) + shift);

export async function clearTrail(title: string): Promise<void> {
  await sql`
    delete from ai_requests
    where media_id in (
        select pi.media_id
        from project_items pi
        join projects p on p.id = pi.project_id
        where p.title = ${title}
      )
      or montage_id in (
        select m.id
        from montages m
        join projects p on p.id = m.project_id
        where p.title = ${title}
      )
  `;
  // The project deletion only removes media it uploaded; the movie's video,
  // thumbnail and preview are not the seed's uploads, so they outlive it.
  if (movie) {
    await sql`
      delete from media_items
      where id in (${movie.media.video.id}, ${movie.media.thumbnail.id}, ${movie.media.preview.id})
    `;
  }
}

export async function applySnapshot(
  projectId: string,
  uploaded: Map<string, UploadedMedia>,
): Promise<void> {
  const seeded = (file: string): UploadedMedia => {
    const found = uploaded.get(file);
    if (!found) throw new Error(`test seed: no uploaded asset ${file}`);
    return found;
  };

  const ids = new Map<string, string>();
  for (const item of snapshot.items) {
    const now = seeded(item.file);
    ids.set(item.itemId, now.itemId);
    ids.set(item.mediaId, now.mediaId);
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remap);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, remap(one)]));
    }
    return value;
  };

  const [member] = await sql<{ userId: string }[]>`
    select user_id as "userId"
    from project_members
    where project_id = ${projectId} and role = 'admin'
    limit 1
  `;
  if (!member) throw new Error("test seed: seeded project has no admin");

  if (movie) {
    for (const part of PARTS) {
      const media = movie.media[part];
      const { file, contentType } = MOVIE_FILES[part];
      await putObject(
        media.storageKey,
        readFileSync(join(ANTHROPOVY_ASSETS, "movie", file)),
        contentType,
      );
    }
  }

  await sql.begin(async (tx) => {
    await tx`update projects set created_at = ${at(snapshot.project.createdAt)} where id = ${projectId}`;
    await tx`update project_members set joined_at = ${at(snapshot.project.createdAt)} where project_id = ${projectId}`;

    for (const item of snapshot.items) {
      const now = seeded(item.file);
      await tx`
        update project_items
        set analysis = ${item.analysis === null ? null : tx.json(item.analysis as never)},
            description = ${item.description},
            created_at = ${at(item.createdAt)}
        where id = ${now.itemId}
      `;
      await tx`update media_items set created_at = ${at(item.createdAt)} where id = ${now.mediaId}`;
    }

    for (const job of snapshot.analysisJobs) {
      await tx`
        insert into jobs (kind, ref, status, attempts, run_after, error, created_at, updated_at)
        values (
          'media_analysis', ${seeded(job.file).mediaId}, ${job.status}, 0,
          ${at(job.runAfter)}, ${job.error}, ${at(job.createdAt)}, ${at(job.updatedAt)}
        )
      `;
    }

    await tx`
      insert into montages (id, project_id, created_by, status, created_at, error, manifest, journal)
      values (
        ${snapshot.montage.id}, ${projectId}, ${member.userId}, ${snapshot.montage.status},
        ${at(snapshot.montage.createdAt)}, ${snapshot.montage.error},
        ${tx.json(remap(snapshot.montage.manifest) as never)},
        ${tx.json(remap(snapshot.montage.journal) as never)}
      )
    `;
    await tx`
      insert into jobs (kind, ref, status, attempts, run_after, error, created_at, updated_at)
      values (
        'montage', ${snapshot.montage.id}, ${snapshot.montage.job.status}, 0,
        ${at(snapshot.montage.job.runAfter)}, ${snapshot.montage.job.error},
        ${at(snapshot.montage.job.createdAt)}, ${at(snapshot.montage.job.updatedAt)}
      )
    `;

    for (const request of snapshot.aiRequests) {
      const mediaId = request.file === null ? null : seeded(request.file).mediaId;
      await tx`
        insert into ai_requests (
          media_id, montage_id, operation, provider, model, status, input_tokens,
          output_tokens, total_tokens, cached_tokens, reasoning_tokens, duration,
          cost_usd, error, created_at
        )
        values (
          ${mediaId}, ${request.montage ? snapshot.montage.id : null}, ${request.operation},
          ${request.provider}, ${request.model}, ${request.status}, ${request.inputTokens},
          ${request.outputTokens}, ${request.totalTokens}, ${request.cachedTokens},
          ${request.reasoningTokens}, ${request.duration}, ${request.costUsd},
          ${request.error}, ${at(request.createdAt)}
        )
      `;
    }

    if (movie) {
      for (const part of PARTS) {
        const media = movie.media[part];
        await tx`
          insert into media_items (
            id, parent_media_id, kind, storage_key, uploaded_by, format, bytes,
            width, height, duration, created_at
          )
          values (
            ${media.id}, ${media.parentMediaId}, ${media.kind}, ${media.storageKey}, null,
            ${media.format}, ${media.bytes}, ${media.width}, ${media.height},
            ${media.duration}, ${at(media.createdAt)}
          )
        `;
      }
      await tx`
        insert into movies (
          id, name, project_id, created_by, created_at, montage_id, video_id,
          thumbnail_id, preview_id
        )
        values (
          ${movie.id}, ${movie.name}, ${projectId}, ${member.userId},
          ${at(movie.createdAt)}, ${snapshot.montage.id},
          ${movie.media.video.id}, ${movie.media.thumbnail.id}, ${movie.media.preview.id}
        )
      `;
    }
  });
}
