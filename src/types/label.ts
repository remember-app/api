import type { LabelId, ProjectId, ProjectItemId, UserId } from "./id.ts";

export type Label = {
  id: LabelId;
  projectId: ProjectId;
  ownerId: UserId;
  name: string;
  color: `#${string}`;
  itemsIds: ProjectItemId[];
};
