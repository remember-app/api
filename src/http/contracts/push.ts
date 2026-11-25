export type PushPlatform = "ios" | "android";

export type PushData =
  | {
      kind: "invite";
      projectId: string;
    }
  | {
      kind: "movie_ready";
      montageId: string;
    }
  | {
      kind: "montage_failed";
      montageId: string;
    };

export type RegisterPushTokenRequest = {
  token: string;
  platform: PushPlatform;
};

export type RemovePushTokenRequest = {
  token: string;
};
