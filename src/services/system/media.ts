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
      ru: "Фото с праздника остаются у каждого из гостей.",
      en: "Everyone leaves the party with their own photos.",
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
      ru: "Все кадры собраны в одном воспоминании.",
      en: "All the shots live in one memory.",
    },
  },
  {
    name: "onboarding-3",
    mediaId: "00000000-0000-4000-8000-000000000014",
    file: "onboarding-4.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Друзья добавляют свои фото без напоминаний.",
      en: "Friends add their photos without reminders.",
    },
  },
  {
    name: "onboarding-4",
    mediaId: "00000000-0000-4000-8000-000000000015",
    file: "onboarding-5.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Концерт или свадьба становятся фильмом.",
      en: "A concert or a wedding becomes a film.",
    },
  },
  {
    name: "onboarding-5",
    mediaId: "00000000-0000-4000-8000-000000000013",
    file: "onboarding-3.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Готовый ролик остаётся с вами надолго.",
      en: "The finished film stays with you.",
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
