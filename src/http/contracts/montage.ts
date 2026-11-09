export type MontageStage = "analysis" | "preparation" | "directing" | "editing";

export type MontageStatus = "queued" | "processing" | "done" | "failed";

export type MontageResponse = {
  id: string;
  projectId: string;
  createdBy: string;
  status: MontageStatus;
  stage: MontageStage;
  createdAt: string;
  error: string | null;
  itemIds: string[];
  movieId: string | null;
};

export type MontageSettingsResponse = {
  targetSeconds: number;
  prompt: string | null;
  dimensions: { width: number; height: number };
  musicIds: string[];
};

export type MontageCreateRequest = {
  templateId?: string | null;
  payFrom: "project" | "user";
  config: MontageSettingsResponse & {
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
