/**
 * What a montage is to the database — the row and the words its `params` are
 * written in. Everything else in this folder reads this shape: the order writes
 * one, the list hands them out, the worker fills the rest in itself.
 */

/** A `montages` row exactly as the database holds it. */
export type Montage = {
  id: string;
  memory_id: string;
  ordered_by: string;
  status: "queued" | "processing" | "ready" | "failed";
  video_key: string | null;
  /** The frame the app shows before the video plays; the worker cuts it. */
  poster_key: string | null;
  duration_seconds: number | null;
  params: {
    target_seconds?: number;
    /** What the organizer said the video is about, in their own words (doc-03). */
    story_text?: string;
    /** The frames picked out by hand: these go in, those stay out (doc-03). */
    include_media_ids?: string[];
    exclude_media_ids?: string[];
    /**
     * The music, in the order it plays: shelf ids (`musicTracks`) and keys of
     * the organizer's own tracks, mixed as they like (doc-03). Written on every
     * new order even when it is empty — empty *is* the answer «без музыки», and
     * the worker can only tell it from an old order that never carried the field
     * by the field being there.
     */
    music_tracks?: string[];
    /**
     * What the organizer wished of each track, in their own words (doc-03):
     * keyed by the track as `music_tracks` names it, so the worker hands every
     * wish on with its own track. Written only when there is a wish to write.
     */
    music_wishes?: Record<string, string>;
    /**
     * Old rows only — the one track an order used to name, before
     * `music_tracks`, and the one wish for the whole order, before
     * `music_wishes`. Nothing writes these any more and no order may ask for
     * them; they are read because the videos ordered with them are still in
     * the list, and repeating a failed one replays its own `params`.
     */
    music_track_id?: string;
    music_track_key?: string;
    music_note?: string;
    orientation?: (typeof orientations)[number];
  };
  error_text: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Which way round the video is cut (doc-03: «горизонтальный ролик или
 * вертикальный», уточнено 2026-09-09). Ordered without one means landscape,
 * and that is left as the missing key rather than written down: every montage
 * ordered before today has no `orientation` in its `params` either, so the
 * worker reads «поля нет» as landscape whatever api does — and a default
 * spelled out here would only be a key that says what its absence already
 * says. The chosen one is written, because that is a choice somebody made.
 */
export const orientations = ["landscape", "portrait"] as const;
