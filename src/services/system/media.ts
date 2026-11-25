import { config } from "../../config.ts";
import { downloadUrl } from "../../integrations/storage/s3.ts";

export type SystemMediaCaptions = { ru: string; en: string };

export type SystemMediaEntry = {
  name: string;
  mediaId: string;
  file: string;
  format: string;
  contentType: string;
  width: number | null;
  height: number | null;
  captions: SystemMediaCaptions | null;
};

export const SYSTEM_MEDIA: readonly SystemMediaEntry[] = [
  {
    name: "audio-cover",
    mediaId: "00000000-0000-4000-8000-000000000001",
    file: "audio-cover.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 800,
    height: 800,
    captions: null,
  },
  {
    name: "song-cover",
    mediaId: "00000000-0000-4000-8000-000000000007",
    file: "song-cover.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 800,
    height: 800,
    captions: null,
  },
  {
    name: "onboarding-1",
    mediaId: "00000000-0000-4000-8000-000000000011",
    file: "onboarding-1.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Фото с праздника остаются у каждого — соберите их в одном месте.",
      en: "Party photos stay on everyone's phones — bring them into one place.",
    },
  },
  {
    name: "onboarding-2",
    mediaId: "00000000-0000-4000-8000-000000000012",
    file: "onboarding-2.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Создайте воспоминание и позовите друзей: они добавят свои кадры.",
      en: "Create a memory and invite friends: they add their own shots.",
    },
  },
  {
    name: "onboarding-3",
    mediaId: "00000000-0000-4000-8000-000000000013",
    file: "onboarding-3.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Потом приложение само смонтирует ролик из всех кадров.",
      en: "Then the app cuts a film from all the shots.",
    },
  },
];

export const systemMediaKey = (entry: SystemMediaEntry): string =>
  `remember/${entry.format}/${entry.mediaId}`;

export type SystemMediaItem = {
  name: string;
  mediaId: string;
  url: string;
  width: number | null;
  height: number | null;
  captions: SystemMediaCaptions | null;
};

export async function listSystemMedia(): Promise<SystemMediaItem[]> {
  const ttl = config.media.downloadTtlSeconds();
  return Promise.all(
    SYSTEM_MEDIA.map(async (entry) => ({
      name: entry.name,
      mediaId: entry.mediaId,
      url: await downloadUrl(systemMediaKey(entry), ttl),
      width: entry.width,
      height: entry.height,
      captions: entry.captions,
    })),
  );
}
