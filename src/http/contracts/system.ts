export type SystemMediaCaptions = { ru: string; en: string };

export type SystemMediaItem = {
  name: string;
  mediaId: string;
  url: string;
  width: number | null;
  height: number | null;
  captions: SystemMediaCaptions | null;
};

export type SystemMediaResponse = { items: SystemMediaItem[] };
