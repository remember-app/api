import type { MediaId, MontageId } from "./id.ts";

export type Job = JobMediaDerive | JobMontage;

export type JobMediaDerive = JobBase & {
  kind: "media_derive";
  ref: MediaId;
};

export type JobMontage = JobBase & {
  kind: "montage";
  ref: MontageId;
};

export type JobBase = {
  id: number;
  status: JobStatus;
  attempts: number;
  runAfter: Date;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JobStatus = "queued" | "running" | "done" | "failed";
