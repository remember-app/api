export type AvatarStartRequest = {
  fileName: string;
};

export type AvatarStartResponse = {
  mediaId: string;
  url: string;
};

export type AvatarResponse = {
  url: string | null;
};
