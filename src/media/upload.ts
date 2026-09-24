import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";
import { uuidPattern } from "../memories/plugin.ts";
import {
  maxFileBytes,
  maxVideoSeconds,
  memoryMaxBytes,
  memoryMaxFiles,
  partBytes,
  uploadTtlSeconds,
} from "./config.ts";
import { dropKeys } from "./gallery.ts";
import {
  completeUpload,
  createUpload,
  headSize,
  partUrls,
  storageConfigured,
  type UploadedPart,
} from "./r2.ts";

/**
 * A `media_items` row. `size_bytes` is a string for the reason
 * `memories.storage_bytes` is: it is a bigint, and postgres.js hands those
 * over as strings rather than silently rounding past 2^53.
 */
export type MediaItem = {
  id: string;
  memory_id: string;
  uploaded_by: string;
  kind: "photo" | "video";
  status: "pending_upload" | "processing" | "ready" | "failed";
  original_key: string;
  upload_id: string | null;
  size_bytes: string;
  captured_at: Date | null;
  // What the file was called on the phone, sent with the intent. Null for
  // everything that arrived before the app started sending it, and for any
  // client that does not; «Сведения о кадре» then leaves that line out.
  file_name: string | null;
  // Written by the montage worker when it probes the original and makes the
  // derivatives; null until then, which the gallery shows as a record still
  // being worked on. The camera and the place come off the same probe and are
  // read by «Сведения о кадре» alone (`frame.ts`).
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  thumbnail_key: string | null;
  preview_key: string | null;
  camera_model: string | null;
  focal_length_mm: number | null;
  aperture: number | null;
  latitude: number | null;
  longitude: number | null;
  // The automatic screening's verdict, written by the same worker and read by
  // nobody here but the gallery (doc-03): whether the analysis would throw this
  // frame out and why. Null is «not looked at yet», not «kept» — the reason is
  // null as well for a frame that was kept.
  screening_rejected: boolean | null;
  screening_reason: string | null;
  created_at: Date;
};

const intentBody = {
  type: "object",
  required: ["kind", "size_bytes"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["photo", "video"] },
    // The declared size, which is what the limits are checked against before a
    // single byte is accepted. What is counted afterwards is what R2 measured.
    size_bytes: { type: "integer", minimum: 1 },
    // RFC 3339 with an offset, as `event_start` is: the montage compares this
    // instant against the memory's window. Nullable as well as optional — a
    // file may carry no capture date at all.
    captured_at: { type: ["string", "null"], format: "date-time" },
    // Required for a video and ignored for a photo; see the handler.
    duration_seconds: { type: ["number", "null"], minimum: 0 },
    // What the file is called on the phone, shown by «Сведения о кадре»
    // (doc-02). Optional because the app began sending it later than it began
    // uploading, and bounded at what a filesystem itself holds — this is a
    // caption, not a place to carry a payload.
    file_name: { type: ["string", "null"], maxLength: 255 },
  },
} as const;

/**
 * Shared with the music callback (`src/montages/music.ts`): a track is sent in
 * parts exactly as a file is, so the two callbacks take the same body and there
 * is one etag pattern to keep honest rather than two.
 */
export const completeBody = {
  type: "object",
  required: ["parts"],
  additionalProperties: false,
  properties: {
    // What R2 answered each `PUT` with. Ordered by the client or by us — the
    // storage layer sorts them — but none may be missing.
    parts: {
      type: "array",
      minItems: 1,
      maxItems: 10000,
      items: {
        type: "object",
        required: ["part_number", "etag"],
        additionalProperties: false,
        properties: {
          part_number: { type: "integer", minimum: 1, maximum: 10000 },
          // The shape S3 actually receipts a part with — a hex digest, quoted
          // by the header the client reads it out of, sometimes with a part
          // count after a dash. Pinned rather than «any string» because this
          // value is interpolated into the XML the api signs with its own
          // credentials (`completeUpload`), and `<`, `>` and `&` have no
          // business in an etag.
          etag: {
            type: "string",
            pattern: '^"?[A-Za-z0-9]{1,64}(-[0-9]{1,5})?"?$',
            maxLength: 200,
          },
        },
      },
    },
  },
} as const;

/**
 * How many slices the client will cut a file of this size into. Shared with the
 * music intent (`src/montages/music.ts`) for the reason `completeBody` is: a
 * track is sliced exactly as a file is, and one arithmetic to keep in step with
 * `partBytes` is better than two.
 */
export const partCount = (sizeBytes: number) => Math.max(1, Math.ceil(sizeBytes / partBytes()));

/**
 * The multipart upload this row is waiting on, started if it is not there yet.
 * Both the first link and every re-issued one come through here, which is what
 * makes «дай ссылку заново» resume rather than restart: the same upload id
 * keeps the parts already sent.
 */
async function ensureUpload(item: MediaItem): Promise<string> {
  if (item.upload_id) return item.upload_id;
  const uploadId = await createUpload(item.original_key);
  await sql`
    update media_items set upload_id = ${uploadId}, updated_at = now() where id = ${item.id}
  `;
  return uploadId;
}

/** Everything the client needs to push the bytes itself, and nothing else. */
async function uploadPlan(item: MediaItem) {
  const uploadId = await ensureUpload(item);
  const ttl = uploadTtlSeconds();
  const size = Number(item.size_bytes);
  return {
    id: item.id,
    status: item.status,
    upload: {
      key: item.original_key,
      upload_id: uploadId,
      part_size: partBytes(),
      // Handed out whole rather than one at a time: a phone on a bad line
      // retries a part, and a round trip per retry is the thing this avoids.
      parts: (await partUrls(item.original_key, uploadId, partCount(size), ttl)).map(
        (url, index) => ({ part_number: index + 1, url }),
      ),
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    },
  };
}

/**
 * Taking material into a memory: the intent that hands out a signed multipart
 * link, the re-issue of that link when it goes stale, and the callback that
 * says the bytes are there.
 *
 * The bytes themselves never touch the API — it only signs, counts and queues
 * (architecture.md, «Хранилище и медиа-пайплайн»).
 *
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the
 * membership check these routes hang on.
 */
export function uploadRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };

  /** Without a bucket there is nothing to sign, and saying so is not the caller's fault. */
  const unconfigured = { error: "storage not configured" };

  /**
   * The caller's own row in this memory. Not theirs, not in this memory, no
   * such row and «not a uuid» are one 404 — the house rule of this route
   * family (docs/auth.md, «Домашнее правило: 404 один на всех»). Ownership and not
   * role: an organizer may delete anyone's media, but only the person who
   * started an upload can finish it.
   */
  async function ownItem(memoryId: string, userId: string, mediaId: string) {
    if (!uuidPattern.test(mediaId)) return undefined;
    const [item] = await sql<MediaItem[]>`
      select * from media_items
      where id = ${mediaId} and memory_id = ${memoryId} and uploaded_by = ${userId}
    `;
    return item;
  }

  app.post<{
    Params: { memoryId: string };
    Body: {
      kind: "photo" | "video";
      size_bytes: number;
      captured_at?: string | null;
      duration_seconds?: number | null;
      file_name?: string | null;
    };
  }>(
    "/memories/:memoryId/media",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: intentBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      // The matrix: a viewer looks, a contributor brings. A non-member never
      // reaches this line — they were answered 404 by the membership check.
      if (role === "viewer") return reply.code(403).send({ error: "forbidden" });
      if (!storageConfigured()) return reply.code(503).send(unconfigured);

      const { kind, size_bytes, captured_at } = request.body;
      // A video's length can only be checked against the limit if the client
      // says what it is; the worker measures it for real when it makes the
      // preview, and a file that lied is failed there.
      const duration = request.body.duration_seconds ?? null;
      if (kind === "video" && duration === null) {
        return reply.code(400).send({ error: "duration_seconds is required for a video" });
      }

      // Every refusal below happens before the insert: a file that does not fit
      // leaves no row and no key.
      if (size_bytes > maxFileBytes()) {
        return reply.code(413).send({ error: "file is too large", limit_bytes: maxFileBytes() });
      }
      if (kind === "video" && duration !== null && duration > maxVideoSeconds()) {
        return reply
          .code(413)
          .send({ error: "video is too long", limit_seconds: maxVideoSeconds() });
      }
      // The memory's counters as the membership check already loaded them.
      // ponytail: they move when an upload completes, so uploads in flight are
      // not counted and a burst can end up over the ceiling by whatever is in
      // the air. The next intent then refuses — good enough while a person
      // uploads from one phone.
      if (memory.media_count >= memoryMaxFiles()) {
        return reply.code(409).send({ error: "memory is full", limit_files: memoryMaxFiles() });
      }
      if (BigInt(memory.storage_bytes) + BigInt(size_bytes) > BigInt(memoryMaxBytes())) {
        return reply
          .code(409)
          .send({ error: "memory is out of space", limit_bytes: memoryMaxBytes() });
      }

      // The phone's own name for the file, kept as it came — it is shown back
      // to people and nothing here parses it. A NUL is stripped rather than
      // refused, as `story_text` strips one: no `text` column can hold that
      // byte, nobody typed it on purpose, and a 500 over a stray character in a
      // file name would stop an upload that is otherwise fine. Empty after that
      // is nothing said at all, and nothing said is null.
      const fileName = request.body.file_name?.replaceAll("\u0000", "").trim() || null;

      // The id is minted here rather than by the database because the key is
      // made of it (architecture.md: «ключ оригинала — по id записи»), and the
      // row must carry the key it was written with.
      const id = randomUUID();
      const [item] = await sql<MediaItem[]>`
        insert into media_items
          (id, memory_id, uploaded_by, kind, original_key, size_bytes, captured_at,
           duration_seconds, file_name)
        values (${id}, ${memory.id}, ${request.user.id}, ${kind}, ${`originals/${id}`},
                ${size_bytes}, ${captured_at ?? null}, ${kind === "video" ? duration : null},
                ${fileName})
        returning *
      `;
      if (!item) throw new Error("insert into media_items returned no row");

      // The row first, the upload second: a row without an upload is picked up
      // by the next link request or swept away after a day, while an upload
      // without a row is an orphan in R2 that nothing can ever finish.
      return reply.code(201).send(await uploadPlan(item));
    },
  );

  // The stale link, asked for again. No new row and no new upload — the same
  // record, the same multipart upload, freshly signed, so whatever already
  // reached R2 stays there (architecture.md, «Обработка ошибок»).
  app.get<{ Params: { memoryId: string; mediaId: string } }>(
    "/memories/:memoryId/media/:mediaId/upload",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const item = await ownItem(
        request.membership.memory.id,
        request.user.id,
        request.params.mediaId,
      );
      if (!item) return reply.code(404).send(notFound);
      // Already uploaded: there is nothing left to sign, and re-signing would
      // hand out a link that overwrites material the worker is busy with.
      if (item.status !== "pending_upload") {
        return reply.code(409).send({ error: "upload is already finished", status: item.status });
      }
      return uploadPlan(item);
    },
  );

  // «Загружено». Seals the object in R2, moves the counters and queues the
  // preview — and says the same thing however many times it is called.
  app.post<{ Params: { memoryId: string; mediaId: string }; Body: { parts: UploadedPart[] } }>(
    "/memories/:memoryId/media/:mediaId/complete",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: completeBody } },
    async (request, reply) => {
      if (!storageConfigured()) return reply.code(503).send(unconfigured);
      const { memory } = request.membership;
      const item = await ownItem(memory.id, request.user.id, request.params.mediaId);
      if (!item) return reply.code(404).send(notFound);

      // The repeat callback, which is the ordinary case for a phone that lost
      // the answer to the first one: whatever the record has become since is
      // what it hears, and nothing is counted twice. `first_upload` is false
      // rather than absent so that the answer to this route has one shape —
      // the client reads the field, not the branch it came from.
      if (item.status !== "pending_upload") {
        return { id: item.id, status: item.status, first_upload: false };
      }
      if (!item.upload_id) return reply.code(409).send({ error: "upload was never started" });

      // Failure here is not fatal on its own: two callbacks racing means the
      // second finds the upload already sealed. The HEAD below is the actual
      // answer to «are the bytes there», so this only has to be attempted.
      try {
        await completeUpload(item.original_key, item.upload_id, request.body.parts);
      } catch (error) {
        request.log.warn({ err: error, media: item.id }, "completing the upload failed");
      }

      // What R2 holds, not what the client declared: the declared size is what
      // the limits were checked against, but it is also the one number a client
      // could understate to have its material counted small.
      const size = await headSize(item.original_key);
      if (size === null) {
        return reply.code(409).send({ error: "the upload is not in storage" });
      }

      // The limits again, and this time against the only number that is not the
      // client's. The intent weighed what was *declared*, and a presigned part
      // carries no length of its own — so a file announced as one byte and then
      // filled with a gigabyte would sail past both ceilings and be counted in
      // at its real size, leaving the memory permanently over. Refused here the
      // record and the object both go, exactly as a refusal at intent leaves
      // neither.
      const overSized = size > maxFileBytes();
      const overMemory = BigInt(memory.storage_bytes) + BigInt(size) > BigInt(memoryMaxBytes());
      if (overSized || overMemory) {
        await sql`delete from media_items where id = ${item.id} and status = 'pending_upload'`;
        await dropKeys(request.log, { keys: [item.original_key], uploads: [] });
        request.log.warn(
          { media: item.id, declared: item.size_bytes, measured: size },
          "an upload arrived larger than it was declared and was refused",
        );
        return overSized
          ? reply.code(413).send({ error: "file is too large", limit_bytes: maxFileBytes() })
          : reply
              .code(409)
              .send({ error: "memory is out of space", limit_bytes: memoryMaxBytes() });
      }

      const firstUpload = await sql.begin(async (tx) => {
        // The whole of the idempotency, and it is atomic: whoever flips the
        // status owns moving the counters. A second caller updates no row and
        // therefore counts nothing.
        const [claimed] = await tx`
          update media_items
          set status = 'processing', size_bytes = ${size}, updated_at = now()
          where id = ${item.id} and status = 'pending_upload'
          returning id
        `;
        if (!claimed) return false;

        await tx`
          update memories
          set storage_bytes = storage_bytes + ${size}, media_count = media_count + 1
          where id = ${memory.id}
        `;
        // The same transaction, per architecture.md: a tally that can drift
        // from the media it counts is worse than no tally.
        await tx`
          insert into user_usage (user_id, storage_bytes, upload_count)
          values (${item.uploaded_by}, ${size}, 1)
          on conflict (user_id) do update set
            storage_bytes = user_usage.storage_bytes + excluded.storage_bytes,
            upload_count = user_usage.upload_count + 1,
            updated_at = now()
        `;
        // Queued inside the transaction as well: a job for a row that never
        // reached `processing` would have the worker chasing nothing.
        // The table belongs to montage — api only inserts here.
        await tx`insert into jobs (type, ref) values ('media_preview', ${item.id})`;

        // doc-06: bringing something is what takes a member off the initial
        // status. Also off `nothing` — that one is a claim about the future
        // («материала от меня не будет»), and a file landing is the fact that
        // falsifies it. Left alone, the roster read «ждать нечего» over a
        // person whose photos were in the gallery, and nothing would correct it
        // unprompted: the question is only asked on a first upload, and nobody
        // goes back into the settings to take back what they said before the
        // photos existed. That stale line is the exact drift doc-06 exists to
        // remove.
        //
        // `done` is deliberately left standing: it says «я всё загрузил», which
        // more material makes out of date but not untrue, and re-opening it
        // would re-ask a question the person has already answered.
        //
        // The guard is in the WHERE and not only in the `if`: two callbacks of
        // the same person racing must both leave `more_coming`, and exactly one
        // of them may report it. Same transaction as the counters — a member
        // counted as having brought material while still reading «ничего не
        // загрузил» is the same drift one statement later.
        if (request.membership.status === "more_coming") return false;
        if (request.membership.status === "done") return false;
        const moved = await tx`
          update memory_members set status = 'more_coming'
          where memory_id = ${memory.id} and user_id = ${request.user.id}
            and status in ('not_started', 'nothing')
          returning user_id
        `;
        // Only a genuine first upload asks «всё загрузили?». Correcting a
        // «ждать нечего» is not one: the status now tells the truth on its own,
        // and the person said their piece already.
        return moved.length > 0 && request.membership.status === "not_started";
      });

      // Read back rather than assumed: by now the worker may already have taken
      // it past `processing`, and a race lost above must not be answered with a
      // status that was never true.
      const [current] = await sql<{ id: string; status: string }[]>`
        select id, status from media_items where id = ${item.id}
      `;
      // Gone between the transaction and this line: the worker's hourly sweep
      // reached a record this callback was a day late for, or its owner walked
      // out while it was in the air. Answering `undefined` would leave the
      // request hanging with no body at all, so it is the one 404 this route
      // family gives everything that is not there.
      if (!current) return reply.code(404).send(notFound);
      // `first_upload` is the api telling the app to ask «всё загрузили или
      // ещё будете?» — it is the one moment doc-06 hangs that question on, and
      // the app has no other way to know this upload was the person's first.
      return { ...current, first_upload: firstUpload };
    },
  );
}
