import type { PageResponse } from "./common.ts";

export type LabelResponse = {
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  colorHex: `#${string}`;
  description: string | null;
  shared: boolean;
  itemCount: number;
  createdAt: string;
};

export type LabelsPageResponse = PageResponse<LabelResponse>;

export type CreateLabelRequest = {
  name: string;
  colorHex: `#${string}`;
  shared: boolean;
  description?: string | null;
};

export type UpdateLabelRequest = {
  name?: string;
  colorHex?: `#${string}`;
  description?: string | null;
};

export type LabelItemsRequest = {
  itemIds: string[];
};

export type LabelItemsResponse = {
  attached?: number;
  detached?: number;
};
