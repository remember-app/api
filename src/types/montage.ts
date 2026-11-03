import type { MediaId, MontageId, ProjectId, ProjectItemId, TemplateId, UserId } from "./id.ts";
import type { MediaDimension } from "./mediaItem.ts";

export type Montage = {
  id: MontageId;
  projectId: ProjectId;
  createdBy: UserId;
  status: MontageStatus;
  createdAt: Date;
  error: string | null;
  templateId: TemplateId | null;
  config: MontageConfig;
  journal: MontageJournal;
};

export type MontageConfig = MontageSetting & MontageSource;

export type MontageTemplate = {
  id: TemplateId;
  name: string;
  settings: MontageSetting;
  referenceMediaId: MediaId | null;
};

export type MontageJournal = {};

export type MontageStage = "prep" | "analysis" | "directing" | "music" | "assembly";

export type MontageJournalEntry =
  | MontagePrepEntry
  | MontageAnalysisEntry
  | MontageDirectingEntry
  | MontageMusicEntry
  | MontageAssemblyEntry;

export type MontagePrepEntry = MontageJournalEntryBase & {
  message: string;
};

export type MontageAnalysisEntry = MontageJournalEntryBase & {
  mediaId: MediaId;
  description: string;
};

export type MontageDirectingEntry = MontageJournalEntryBase & {
  mediaId: MediaId;
  decision: "take" | "skip";
  reason: string | null;
};

export type MontageMusicEntry = MontageJournalEntryBase & {
  action: string;
};

export type MontageAssemblyEntry = MontageJournalEntryBase & {
  message: string;
};

export type MontageJournalEntryBase = {};

export type MontageStatus = "queued" | "processing" | "done" | "failed";

export type MontageSetting = {
  targetSeconds: number;
  prompt: string | null;
  dimensions: MediaDimension;
  musicIds: MediaId[] | null;
};

export type MontageSource = {
  includeMediaIds: ProjectItemId[];
  requiredMediaIds: ProjectItemId[];
};
