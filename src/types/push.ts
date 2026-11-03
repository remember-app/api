import type { MovieId, ProjectId, UserId } from "./id.ts";

export type PushToken = {
  token: string;
  userId: UserId;
  platform: PushPlatform;
  createdAt: Date;
};

export type PushNotification =
  | {
      kind: "invite";
      projectId: ProjectId;
      invitedBy: UserId;
    }
  | {
      kind: "movieReady";
      projectId: ProjectId;
      movieId: MovieId;
    };

export type PushPlatform = "ios" | "android";
