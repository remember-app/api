import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { seenBy, uuidPattern } from "../memories/plugin.ts";
import type { Montage } from "../montages/row.ts";
import { montageName } from "../montages/view.ts";
import type { MediaItem } from "./upload.ts";

/**
 * One frame on its own. «Сведения о кадре» (doc-02,
 * `design/screens/SheetFrameInfo.html`): everything about it that the picture
 * itself does not say — who brought it and when, the file it arrived as, the
 * camera and the place it was shot at, and which finished videos it stands in,
 * at which second. And «Мой кадр» (`design/screens/SheetMyFrame.html`): what
 * the person who brought it may change about it — hide it, correct when and
 * where it was shot.
 *
 * The sheet is one route, because it is one sheet: the app opens it over a
 * frame it is already showing, so there is nothing here to sign and no link to
 * hand out — the thumbnail came with the gallery.
 *
 * Most of its answers are not api's to write. `camera_model`,
 * `focal_length_mm` and `aperture` are the montage worker's, read out of the
 * original's metadata exactly as `width` and `height` are; so are `latitude`
 * and `longitude` until the owner sets the place by hand, after which the
 * database keeps the worker from writing over it (migration 150).
 * `montage_frames` is the worker's too, written while it cuts a video. Null and
 * an empty list are «ещё не посчитано», not «нечего показывать» — the same
 * silence the gallery's missing derivatives keep.
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
  /** How many of the frames that person brought to *this* memory the caller sees. */
  uploader_media_count: number;
};

/**
 * One line of «В роликах» as the database holds it: the video, what it is
 * called, how long it turned out, and the second this frame stands at.
 * `duration_seconds` is the video's, as it is in
 * `GET /memories/:memoryId/montages`, and `start_seconds` is this frame's place
 * inside it. `name` and `params` go out as the one name `montageName` makes of
 * them — the one the list of montages says.
 */
type InMontage = Pick<Montage, "id" | "name" | "params" | "duration_seconds"> & {
  start_seconds: number;
};

/**
 * What the owner may change about their frame. Whatever is not sent stays as it
 * was — the sheet sends what the person touched — and a body that says nothing
 * is not an edit, so it is refused rather than answered `200`.
 *
 * The date is set and never cleared: every frame was shot at some moment, and
 * the phone's is only replaced with the person's. The place may be cleared —
 * `null` in both — because «где» is a thing a person may rightly not want said,
 * and a wrong one is worse than none. Its two numbers travel together: half a
 * place is no place, and a map puts a pin down with both.
 */
const editBody = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  dependencies: { latitude: ["longitude"], longitude: ["latitude"] },
  properties: {
    hidden: { type: "boolean" },
    // RFC 3339 with an offset, as the upload intent takes it.
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
      // such a frame, and to the caller that is «no such record». So is a frame
      // somebody else has hidden, for the same reason.
      //
      // The tally rides in the same statement rather than in a second one: it
      // is one number about the row already being read, and the sheet shows the
      // two on one line («принёс 15 сентября · всего 96 кадров»). It counts
      // what the gallery shows the caller, so frames the uploader has hidden
      // are in it for the uploader alone.
      const [frame] = await sql<FrameRow[]>`
        select i.id, i.file_name, i.size_bytes, i.captured_at, i.created_at,
               i.width, i.height, i.camera_model, i.focal_length_mm, i.aperture,
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
        select m.id, m.name, m.params, m.duration_seconds, f.start_seconds
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
        montages: montages.map(({ params, ...line }) => ({
          ...line,
          name: montageName({ ...line, params }, request.user.language),
        })),
      };
    },
  );

  // «Мой кадр»: hide it, correct when and where it was shot. Only the person
  // who brought it — this is ownership and not role, so not the organizer
  // either — and anybody else's frame is «no such record», as the upload's own
  // routes answer it (`ownItem` in upload.ts).
  app.patch<{ Params: { memoryId: string; mediaId: string }; Body: FrameEdit }>(
    "/memories/:memoryId/media/:mediaId",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: editBody } },
    async (request, reply) => {
      const { mediaId } = request.params;
      // Checked here and not by a params schema, for the reason the sheet gives.
      if (!uuidPattern.test(mediaId)) return reply.code(404).send(notFound);

      const { hidden, captured_at, latitude, longitude } = request.body;
      if ((latitude === null) !== (longitude === null)) {
        return reply
          .code(400)
          .send({ error: "latitude and longitude are set or cleared together" });
      }
      // A place set by hand moves `place_edited_at`, and that move is what lets
      // it through: the trigger of migration 150 keeps the owner's place against
      // every write that leaves the mark where it was — the worker reading the
      // camera again above all. `clock_timestamp()` and not `now()`, so that two
      // edits in one transaction still move it.
      const place =
        latitude === undefined
          ? sql``
          : sql`latitude = ${latitude}, longitude = ${longitude ?? null},
                place_edited_at = clock_timestamp(),`;

      // One statement: the ownership is in the `where`, so nothing can change
      // hands between checking it and writing. Not sent is left alone by
      // `coalesce`, in the query rather than read beforehand, so two edits of
      // different fields at once do not undo each other.
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
