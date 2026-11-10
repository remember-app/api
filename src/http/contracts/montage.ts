export type MontageStage = "analysis" | "preparation" | "directing" | "editing";

export type MontageStatus = "queued" | "processing" | "done" | "failed";

export type MontageSettingsResponse = {
  targetSeconds: number;
  prompt: string | null;
  dimensions: { width: number; height: number };
  musicIds: string[];
};

export type MontageOrderResponse = MontageSettingsResponse & {
  includeItemIds: string[];
  requiredItemIds: string[];
  templateId: string | null;
  name: string | null;
};

export type MontagePreviewResponse = {
  problems: string[];
  tokens: number;
};

export type MontageManifestResponse = {
  preparationConfig: MontageOrderResponse | null;
  directingInput: { mergedMontageData: Record<string, unknown> } | null;
  editingParams: { commands: unknown[] } | null;
};

export type MontageJournalDirectingResponse = {
  text: string;
  usedItemIds: string[];
};

export type MontageJournalResponse = {
  directing: MontageJournalDirectingResponse | null;
};

export type MontageResponse = {
  id: string;
  projectId: string;
  createdBy: string;
  status: MontageStatus;
  manifest: MontageManifestResponse;
  journal: MontageJournalResponse;
  createdAt: string;
  error: string | null;
};

export type MontageCreateRequest = {
  templateId?: string | null;
  payFrom: "project" | "user";
  config: MontageSettingsResponse & {
    name?: string | null;
    includeItemIds: string[];
    requiredItemIds?: string[];
  };
};

export type MontageTemplateResponse = {
  id: string;
  name: string;
  settings: MontageSettingsResponse;
  referenceMediaId: string | null;
};
