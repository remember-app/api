import type { MediaId, MontageId, ProjectId, ProjectItemId, TemplateId, UserId } from "./id.ts";
import type { MediaDimension } from "./mediaItem.ts";

export type MontageStatus = "queued" | "processing" | "done" | "failed";

export type Montage = {
  id: MontageId;
  projectId: ProjectId;
  createdBy: UserId;
  status: MontageStatus;
  manifest: MontageManifest;
  createdAt: Date;
  error: string | null;
};

export type MontageStage = "analysis" | "preparation" | "directing" | "editing";

export type MontageManifest = {
  preparationConfig: MontagePreparationStageConfig | null;
  directingInput: MontageDirectingStageInput | null;
  editingParams: MontageEditingStageParams | null;
};

export type MontagePreparationStageConfig = MontageSetting &
  MontageSource & {
    templateId: TemplateId | null;
  };

export type MontageDirectingStageInput = {
  mergedMontageData: Record<string, unknown>;
};

export type MontageEditingStageParams = {
  commands: unknown[];
};

export type MontageSetting = {
  targetSeconds: number;
  prompt: string | null;
  dimensions: MediaDimension;
  musicIds: MediaId[];
};

export type MontageSource = {
  includeItemIds: ProjectItemId[];
  requiredItemIds: ProjectItemId[];
};

export type MontageTemplate = {
  id: TemplateId;
  name: string;
  settings: MontageSetting;
  referenceMediaId: MediaId | null;
};
