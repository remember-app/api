import { positive } from "../auth/config.ts";
import { sql } from "../db.ts";
import { lowerIds, mediaIdsSchema } from "../memories/plugin.ts";
import { materialLeft, minReadyItems } from "./material.ts";
import { musicTracks } from "./music.ts";
import type { Montage } from "./row.ts";
import { orientations, templateIds } from "./row.ts";

const maxStoryChars = 2000;
const maxWishChars = 500;
const maxTracks = 50;
const defaultTargetSeconds = () => positive("MONTAGE_TARGET_SECONDS", 60);
const storable = (text: string) => text.replaceAll("\u0000", "").replace(/\p{Cs}/gu, "");
export const nameField = { type: "string", maxLength: 200 } as const;
export const nameOf = (text: string | undefined) => storable(text ?? "").trim() || null;
export const orderBodySchema = () => {
  const mediaIds = mediaIdsSchema();
  return {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
      target_seconds: { type: "integer" },
      story_text: { type: "string", maxLength: maxStoryChars },
      include_media_ids: mediaIds,
      exclude_media_ids: mediaIds,
      music_tracks: {
        type: "array",
        items: { type: "string", maxLength: 200 },
        uniqueItems: true,
        maxItems: maxTracks,
      },
      music_director: { type: "boolean" },
      music_wishes: {
        type: "object",
        additionalProperties: { type: "string", maxLength: maxWishChars },
      },
      orientation: { type: "string", enum: [...orientations] },
      name: nameField,
      template: { type: "string", enum: [...templateIds] },
      music_track_id: false,
      music_track_key: false,
    },
  } as const;
};
export type OrderBody = {
  target_seconds?: number;
  story_text?: string;
  include_media_ids?: string[];
  exclude_media_ids?: string[];
  music_tracks?: string[];
  music_director?: boolean;
  music_wishes?: Record<string, string>;
  orientation?: (typeof orientations)[number];
  name?: string;
  template?: (typeof templateIds)[number];
} | null;
export type Order = {
  params: Montage["params"] & {
    target_seconds: number;
  };
  left: Awaited<ReturnType<typeof materialLeft>>;
};
export type Checked =
  | Order
  | {
      code: number;
      body: object;
    };
export async function checkOrder(memoryId: string, body: OrderBody): Promise<Checked> {
  const include = lowerIds(body?.include_media_ids);
  const exclude = lowerIds(body?.exclude_media_ids);
  const excluded = new Set(exclude);
  const both = include.filter((id) => excluded.has(id));
  if (both.length > 0) {
    return {
      code: 400,
      body: { error: "a media item cannot be both included and excluded", media_ids: both },
    };
  }
  const chosen = [...include, ...exclude];
  if (chosen.length > 0) {
    const found = await sql<
      {
        id: string;
      }[]
    >`
      select id from media_items
      where memory_id = ${memoryId} and status = 'ready' and id in ${sql(chosen)}
    `;
    const known = new Set(found.map((row) => row.id));
    const missing = chosen.filter((id) => !known.has(id));
    if (missing.length > 0) {
      return {
        code: 400,
        body: { error: "no such ready media in this memory", media_ids: missing },
      };
    }
  }
  const left = await materialLeft(memoryId, include, exclude);
  const { ready, min_seconds, max_seconds } = left;
  if (ready < minReadyItems || max_seconds === 0) {
    return {
      code: 409,
      body: { error: "not enough material for a montage", ready_items: ready, need: minReadyItems },
    };
  }
  const asked = body?.music_tracks ?? [];
  const tracks = [...new Set(asked.map((name) => storable(name)).filter((name) => name))];
  const director = body?.music_director === true;
  if (director && tracks.length > 0) {
    return { code: 400, body: { error: "music_director cannot be combined with music_tracks" } };
  }
  const shelf = new Set<string>(musicTracks);
  const keys = tracks.filter((name) => !shelf.has(name));
  if (keys.length > 0) {
    const found = await sql<
      {
        object_key: string;
      }[]
    >`
      select object_key from music_uploads
      where memory_id = ${memoryId} and status = 'ready' and object_key in ${sql(keys)}
    `;
    const known = new Set(found.map((row) => row.object_key));
    const missing = keys.filter((key) => !known.has(key));
    if (missing.length > 0) {
      return { code: 400, body: { error: "no such music track", music_tracks: missing } };
    }
  }
  const wishes = Object.fromEntries(
    Object.entries(body?.music_wishes ?? {})
      .map(([name, wish]) => [storable(name), storable(wish).trim()] as const)
      .filter(([, wish]) => wish),
  );
  const played = new Set(tracks);
  const astray = Object.keys(wishes).filter((name) => !played.has(name));
  if (astray.length > 0) {
    return {
      code: 400,
      body: { error: "music wish for a track not in music_tracks", music_wishes: astray },
    };
  }
  const target =
    body?.target_seconds ?? Math.min(Math.max(defaultTargetSeconds(), min_seconds), max_seconds);
  if (target < min_seconds || target > max_seconds) {
    return { code: 400, body: { error: "target_seconds out of range", min_seconds, max_seconds } };
  }
  const story = storable(body?.story_text ?? "").trim();
  return {
    params: {
      target_seconds: target,
      ...(story ? { story_text: story } : {}),
      ...(include.length > 0 ? { include_media_ids: include } : {}),
      ...(exclude.length > 0 ? { exclude_media_ids: exclude } : {}),
      ...(director ? { music_director: true } : { music_tracks: tracks }),
      ...(Object.keys(wishes).length > 0 ? { music_wishes: wishes } : {}),
      ...(body?.orientation ? { orientation: body.orientation } : {}),
    },
    left,
  };
}
