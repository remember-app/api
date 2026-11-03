import type { LabelId, ProjectId, UserId } from "./id.ts";

export type Label = {
  id: LabelId;
  projectId: ProjectId;
  ownerId: UserId;
  name: string;
  colorHex: `#${string}`;
  description: string | null;
  shared: boolean;
  createdAt: Date;
};
