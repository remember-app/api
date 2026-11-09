import type { JobId, MediaId, MontageId, UploadId } from "./id.ts";

export type Job = JobMediaDerive | JobMediaAnalysis | JobMontage;

export type JobMediaDerive = JobBase & {
  kind: "media_derive";
  ref: UploadId;
};

export type JobMediaAnalysis = JobBase & {
  kind: "media_analysis";
  ref: MediaId;
};

export type JobMontage = JobBase & {
  kind: "montage";
  ref: MontageId;
};

export type JobBase = {
  id: JobId;
  status: JobStatus;
  attempts: number;
  runAfter: Date;
  error: string | null;
  dependsOn: JobId[] | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JobStatus = "queued" | "running" | "done" | "failed";
