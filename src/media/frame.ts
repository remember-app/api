import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { seenBy, uuidPattern } from "../memories/plugin.ts";
import type { Montage } from "../montages/row.ts";
import { montageName } from "../montages/view.ts";
import { frameComments } from "./comments.ts";
import { labelCards } from "./labels.ts";
import type { MediaItem } from "./upload.ts";

type FrameRow = {
  id: string;
  file_name: string | null;
  size_bytes: string;
  captured_at: Date | null;
  created_at: Date;
  width: number | null;
  height: number | null;
  camera_model: string | null;
  focal_length_mm: number | null;
  aperture: number | null;
  iso: number | null;
  exposure_ev: number | null;
  shutter: string | null;
  latitude: number | null;
  longitude: number | null;
  uploader_id: string;
  uploader_username: string | null;
  uploader_name: string | null;
  uploader_media_count: number;
};
type InMontage = Pick<Montage, "id" | "name" | "params" | "duration_seconds"> & {
  start_seconds: number;
};
const editBody = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  dependencies: { latitude: ["longitude"], longitude: ["latitude"] },
  properties: {
    hidden: { type: "boolean" },
    captured_at: { type: "string", format: "date-time" },
    latitude: { type: ["number", "null"], minimum: -90, maximum: 90 },
    longitude: { type: ["number", "null"], minimum: -180, maximum: 180 },
  },
} as const;
type FrameEdit = {
  hidden?: boolean;
  captured_at?: string;
  latitude?: number | null;
  longitude?: number | null;
};
export function frameRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  app.get<{
    Params: {
      memoryId: string;
      mediaId: string;
    };
  }>(
    "/memories/:memoryId/media/:mediaId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const memoryId = request.membership.memory.id;
      const { mediaId } = request.params;
      if (!uuidPattern.test(mediaId)) return reply.code(404).send(notFound);
      const [frame] = await sql<FrameRow[]>`
        select i.id, i.file_name, i.size_bytes, i.captured_at, i.created_at,
               i.width, i.height, i.camera_model, i.focal_length_mm, i.aperture,
               i.iso, i.exposure_ev, i.shutter,
               i.latitude, i.longitude,
               u.id as uploader_id, u.username as uploader_username,
               u.name as uploader_name,
               (select count(*)::int from media_items brought
                 where brought.memory_id = i.memory_id
                   and brought.uploaded_by = i.uploaded_by
                   and brought.status <> 'pending_upload'
                   and ${seenBy("brought", request.user.id)}) as uploader_media_count
        from media_items i
        join users u on u.id = i.uploaded_by
        where i.id = ${mediaId} and i.memory_id = ${memoryId}
          and i.status <> 'pending_upload' and ${seenBy("i", request.user.id)}
      `;
      if (!frame) return reply.code(404).send(notFound);
      const [montages, labels, comments] = await Promise.all([
        sql<InMontage[]>`
          select m.id, m.name, m.params, m.duration_seconds, f.start_seconds
          from montage_frames f
          join montages m on m.id = f.montage_id
          where f.media_id = ${mediaId} and m.memory_id = ${memoryId}
            and m.status = 'ready'
          order by m.created_at desc, m.id desc, f.start_seconds
        `,
        labelCards(memoryId, { id: request.user.id, role: request.membership.role }, { mediaId }),
        frameComments(memoryId, mediaId, request.user.id),
      ]);
      const {
        file_name,
        uploader_id,
        uploader_username,
        uploader_name,
        uploader_media_count,
        ...rest
      } = frame;
      return {
        ...rest,
        ...(file_name === null ? {} : { file_name }),
        uploaded_by: {
          id: uploader_id,
          username: uploader_username,
          name: uploader_name,
          media_count: uploader_media_count,
        },
        montages: montages.map(({ params, ...line }) => ({
          ...line,
          name: montageName({ ...line, params }, request.user.language),
        })),
        labels,
        comments,
      };
    },
  );
  app.patch<{
    Params: {
      memoryId: string;
      mediaId: string;
    };
    Body: FrameEdit;
  }>(
    "/memories/:memoryId/media/:mediaId",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: editBody } },
    async (request, reply) => {
      const { mediaId } = request.params;
      if (!uuidPattern.test(mediaId)) return reply.code(404).send(notFound);
      const { hidden, captured_at, latitude, longitude } = request.body;
      if ((latitude === null) !== (longitude === null)) {
        return reply
          .code(400)
          .send({ error: "latitude and longitude are set or cleared together" });
      }
      const place =
        latitude === undefined
          ? sql``
          : sql`latitude = ${latitude}, longitude = ${longitude ?? null},
                place_edited_at = clock_timestamp(),`;
      const [frame] = await sql<
        Pick<MediaItem, "id" | "hidden" | "captured_at" | "latitude" | "longitude">[]
      >`
        update media_items set
          hidden = coalesce(${hidden ?? null}::boolean, hidden),
          captured_at = coalesce(${captured_at ?? null}::timestamptz, captured_at),
          ${place}
          updated_at = now()
        where id = ${mediaId} and memory_id = ${request.membership.memory.id}
          and uploaded_by = ${request.user.id}
        returning id, hidden, captured_at, latitude, longitude
      `;
      if (!frame) return reply.code(404).send(notFound);
      return frame;
    },
  );
}
