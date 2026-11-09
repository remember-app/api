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
    name: "onboarding-1",
    mediaId: "00000000-0000-4000-8000-000000000002",
    file: "onboarding-1.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Здесь вы всё-таки получите все фото с вечеринки от друзей.",
      en: "All the photos from the party with your friends end up here.",
    },
  },
  {
    name: "onboarding-2",
    mediaId: "00000000-0000-4000-8000-000000000003",
    file: "onboarding-2.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Соберёте все воспоминания с дня рождения в одно видео.",
      en: "Every memory from the birthday becomes one film.",
    },
  },
  {
    name: "onboarding-3",
    mediaId: "00000000-0000-4000-8000-000000000004",
    file: "onboarding-3.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Поездка на дачу тоже станет фильмом.",
      en: "Even a weekend at the dacha turns into a movie.",
    },
  },
  {
    name: "onboarding-4",
    mediaId: "00000000-0000-4000-8000-000000000005",
    file: "onboarding-4.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Свадьба, выпускной, концерт — всё окажется в одном месте.",
      en: "A wedding, a graduation, a concert — all in one place.",
    },
  },
  {
    name: "onboarding-5",
    mediaId: "00000000-0000-4000-8000-000000000006",
    file: "onboarding-5.jpg",
    format: "jpeg",
    contentType: "image/jpeg",
    width: 1080,
    height: 1440,
    captions: {
      ru: "Начнёте замечать и сохранять мелкие моменты жизни.",
      en: "You start noticing and keeping the small moments.",
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
