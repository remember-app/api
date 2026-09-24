import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";

/**
 * «Сведения о кадре» (doc-02, `design/screens/SheetFrameInfo.html`): everything
 * about one frame that the picture itself does not say — who brought it and
 * when, the file it arrived as, the camera and the place it was shot at, and
 * which finished videos it stands in, at which second.
 *
 * One route, because it is one sheet: the app opens it over a frame it is
 * already showing, so there is nothing here to sign and no link to hand out —
 * the thumbnail came with the gallery.
 *
 * Three of the answers are not api's to write. `camera_model`,
 * `focal_length_mm`, `aperture`, `latitude` and `longitude` are the montage
 * worker's, read out of the original's metadata exactly as `width` and `height`
 * are; `montage_frames` is the worker's too, written while it cuts a video.
 * Null and an empty list are «ещё не посчитано», not «нечего показывать» — the
 * same silence the gallery's missing derivatives keep.
 */

/** The row behind the sheet: the frame, its uploader, and that person's tally. */
type FrameRow = {
  id: string;
  /** Null for everything uploaded before the app started sending it. */
  file_name: string | null;
  /** A string, as everywhere: postgres.js hands bigints over without rounding them. */
  size_bytes: string;
  captured_at: Date | null;
  created_at: Date;
  width: number | null;
  height: number | null;
  camera_model: string | null;
  focal_length_mm: number | null;
  aperture: number | null;
  latitude: number | null;
  longitude: number | null;
  uploader_id: string;
  uploader_username: string | null;
  uploader_name: string | null;
  /** How many frames that person brought to *this* memory. */
  uploader_media_count: number;
};

/**
 * One line of «В роликах»: the video, how long it turned out, and the second
 * this frame stands at. The montage's own name is not here because it has none
 * yet — templates arrive with m-26, and until then the app builds «Ролик на
 * 1:00» out of the length (TASK-191). `duration_seconds` is therefore the
 * video's, as it is in `GET /memories/:memoryId/montages`, and `start_seconds`
 * is this frame's place inside it.
 */
type InMontage = { id: string; duration_seconds: number | null; start_seconds: number };

/**
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check this route hangs on.
 */
export function frameRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };

  // Read by every member, `viewer` included: the matrix gives them «смотреть
  // галерею», and this is one frame of it in words. A non-member never reaches
  // the handler — the membership check answered them 404.
  //
  // The path is one segment shorter than `/media/:mediaId/download` and
  // `/media/:mediaId/upload`, and a segment longer than the gallery itself, so
  // it takes nothing away from either. `/media/download` keeps working for the
  // reason docs/media.md gives: the router prefers a literal segment to a
  // parameter, whatever the order of declaration.
  app.get<{ Params: { memoryId: string; mediaId: string } }>(
    "/memories/:memoryId/media/:mediaId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const memoryId = request.membership.memory.id;
      const { mediaId } = request.params;
      // «Not a uuid» is «no such record», the house rule of this family
      // (docs/auth.md, «404 один на всех»), and not a params schema for the reason the delete
      // route gives: a schema answers before the membership check has run.
      if (!uuidPattern.test(mediaId)) return reply.code(404).send(notFound);

      // `pending_upload` is left out exactly as the gallery and the download
      // route leave it out: the bytes are not there, the app is not showing
      // such a frame, and to the caller that is «no such record».
      //
      // The tally rides in the same statement rather than in a second one: it
      // is one number about the row already being read, and the sheet shows the
      // two on one line («принёс 15 сентября · всего 96 кадров»).
      const [frame] = await sql<FrameRow[]>`
        select i.id, i.file_name, i.size_bytes, i.captured_at, i.created_at,
               i.width, i.height, i.camera_model, i.focal_length_mm, i.aperture,
               i.latitude, i.longitude,
               u.id as uploader_id, u.username as uploader_username,
               u.name as uploader_name,
               (select count(*)::int from media_items brought
                 where brought.memory_id = i.memory_id
                   and brought.uploaded_by = i.uploaded_by
                   and brought.status <> 'pending_upload') as uploader_media_count
        from media_items i
        join users u on u.id = i.uploaded_by
        where i.id = ${mediaId} and i.memory_id = ${memoryId}
          and i.status <> 'pending_upload'
      `;
      // A record of another memory is «no such record» here, for the same
      // reason another memory is «no such memory».
      if (!frame) return reply.code(404).send(notFound);

      // Only finished videos, and only this memory's. `ready` because a queued
      // or failed montage is not something anybody can open from this sheet,
      // and the memory because the layout table spans the whole product: a row
      // pointing at a video of somebody else's memory must not surface here
      // even if one is ever written by mistake.
      //
      // Newest first, as `GET /memories/:memoryId/montages` is ordered, so the
      // list reads the same way round in both places.
      const montages = await sql<InMontage[]>`
        select m.id, m.duration_seconds, f.start_seconds
        from montage_frames f
        join montages m on m.id = f.montage_id
        where f.media_id = ${mediaId} and m.memory_id = ${memoryId}
          and m.status = 'ready'
        order by m.created_at desc, m.id desc, f.start_seconds
      `;

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
        // Absent rather than null when nobody sent one: «у этого кадра имени
        // файла нет» is a line the sheet does not draw, and a key that says
        // nothing is a key not worth writing. Everything uploaded before the
        // app started sending names comes through here.
        ...(file_name === null ? {} : { file_name }),
        // The three fields every other route hands a person out with, plus the
        // one number this sheet asks for. Deliberately no email, as the roster
        // has none.
        uploaded_by: {
          id: uploader_id,
          username: uploader_username,
          name: uploader_name,
          media_count: uploader_media_count,
        },
        montages,
      };
    },
  );
}
