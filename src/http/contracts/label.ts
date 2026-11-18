import type { PageResponse } from "./common.ts";

export type LabelResponse = {
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  color: `#${string}`;
  itemsIds: string[];
};

export type LabelsPageResponse = PageResponse<LabelResponse>;

export type CreateLabelRequest = {
  name: string;
  color: `#${string}`;
};

export type UpdateLabelRequest = {
  name?: string;
  color?: `#${string}`;
};

export type LabelItemsRequest = {
  itemIds: string[];
};

export type LabelItemsResponse = {
  attached?: number;
  detached?: number;
};
