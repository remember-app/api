export type Montage = {
  id: string;
  memory_id: string;
  ordered_by: string;
  status: "queued" | "processing" | "ready" | "failed";
  name: string | null;
  template: (typeof templateIds)[number] | null;
  video_key: string | null;
  poster_key: string | null;
  duration_seconds: number | null;
  size_bytes: string | null;
  photos: number | null;
  videos: number | null;
  params: {
    target_seconds?: number;
    story_text?: string;
    include_media_ids?: string[];
    exclude_media_ids?: string[];
    music_tracks?: string[];
    music_director?: boolean;
    music_wishes?: Record<string, string>;
    music_track_id?: string;
    music_track_key?: string;
    music_note?: string;
    orientation?: (typeof orientations)[number];
  };
  error_text: string | null;
  created_at: Date;
  updated_at: Date;
};
export const orientations = ["landscape", "portrait"] as const;
export const templateIds = [
  "for_myself",
  "quick",
  "report",
  "short_form",
  "parents",
  "dopamine",
] as const;
