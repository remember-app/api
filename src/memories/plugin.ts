import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { sql } from "../db.ts";
import { downloadTtlSeconds } from "../media/config.ts";
import { downloadUrl, storageConfigured } from "../media/r2.ts";

/** The three levels architecture.md fixes; the matrix is in the README. */
export type MemberRole = "organizer" | "contributor" | "viewer";

/**
 * Where a member stands on bringing their material (doc-06). Per membership,
 * not per person. `more_coming` is the only one the api sets by itself: on the
 * first upload that lands, and again over a `nothing` that material has since
 * proved wrong. `done` and `nothing` are otherwise the member's own word and
 * the api does not overwrite them. It grants and denies nothing: «статус не
 * режет права».
 */
export type ContributionStatus = "not_started" | "more_coming" | "done" | "nothing";

/**
 * A `memories` row exactly as the database holds it. `storage_bytes` is a
 * string and not a number: it is `bigint`, and postgres.js hands those over as
 * strings rather than silently rounding past 2^53.
 */
export type Memory = {
  id: string;
  organizer_id: string;
  title: string;
  event_start: Date;
  event_end: Date | null;
  storage_bytes: string;
  media_count: number;
  montage_count: number;
  created_at: Date;
};

declare module "fastify" {
  interface FastifyInstance {
    /**
     * The membership check for a route under `/memories/:memoryId`. Mounted
     * after the session check:
     * `{ preHandler: [app.authenticate, app.requireMembership] }`.
     */
    requireMembership: preHandlerAsyncHookHandler;
  }
  interface FastifyRequest {
    /** Populated only behind `app.requireMembership` — see the README. */
    membership: { memory: Memory; role: MemberRole; status: ContributionStatus };
  }
}

/**
 * Spelled out rather than `format: "uuid"`, for the reason src/auth's session
 * params give: ajv's uuid format also passes a `urn:uuid:` prefix, which
 * Postgres cannot cast — that arrives as a 500.
 */
export const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const createBody = {
  type: "object",
  required: ["title", "event_start"],
  additionalProperties: false,
  properties: {
    // `pattern` is an unanchored search, so this reads «holds at least one
    // non-whitespace character» — `minLength` alone would let "   " through.
    title: { type: "string", pattern: "\\S", maxLength: 200 },
    // RFC 3339 with an offset, not a bare date. The columns are timestamptz
    // because m-1 compares them against a photo's capture time, so the instant
    // has to come from the client's clock; a bare date would be widened using
    // whatever timezone the server happens to run in.
    event_start: { type: "string", format: "date-time" },
    // Nullable as well as optional: a client holding one form for both shapes
    // sends the field as null rather than dropping it.
    event_end: { type: ["string", "null"], format: "date-time" },
  },
} as const;

/**
 * Memories: creating one, listing one's own, and the membership check every
 * later feature mounts. Called from `buildApp` directly rather than through
 * `app.register` for the reason `authPlugin` is — a decorator declared inside
 * a registered plugin is invisible outside it, and this one exists to be
 * mounted from everywhere.
 */
export function memoriesPlugin(app: FastifyInstance) {
  app.decorate("requireMembership", async (request, reply) => {
    // A misconfigured route rather than a bad request: without the session
    // check ahead of this there is no caller to look a membership up for, and
    // the bare crash would read as «cannot read properties of undefined».
    if (!request.user) {
      throw new Error("app.requireMembership must be mounted after app.authenticate");
    }
    const { memoryId } = request.params as { memoryId?: string };

    // One 404 for all three of: not a uuid, no such memory, not a member.
    // Telling them apart would answer «does this memory exist?» to anybody
    // holding an id, which is how one enumerates other people's memories.
    // Downstream features inherit this — see the README.
    const notFound = () => reply.code(404).send({ error: "not found" });
    if (!memoryId || !uuidPattern.test(memoryId)) return notFound();

    // Membership first, memory second: joining off memory_members means a
    // non-member never reaches the memories row at all, so there is no shape
    // of this query that can leak one.
    // `status` rides along on the same join rather than being read where it is
    // needed: it costs nothing here, and it is the status the caller held when
    // the request started — which is exactly what «первая загрузка» in
    // src/media/upload.ts has to compare against.
    const [row] = await sql<(Memory & { role: MemberRole; status: ContributionStatus })[]>`
      select m.*, mm.role, mm.status
      from memory_members mm
      join memories m on m.id = mm.memory_id
      where mm.memory_id = ${memoryId} and mm.user_id = ${request.user.id}
    `;
    if (!row) return notFound();

    const { role, status, ...memory } = row;
    request.membership = { memory, role, status };
  });

  app.post<{ Body: { title: string; event_start: string; event_end?: string | null } }>(
    "/memories",
    { preHandler: app.authenticate, schema: { body: createBody } },
    async (request, reply) => {
      const { title, event_start, event_end } = request.body;
      // Compared as instants, not as strings: `…T00:00+03:00` sorts after
      // `…T23:00Z` as text while being an hour earlier in fact. The database
      // holds the same rule as a CHECK, which this turns into a 400 instead
      // of a 500.
      if (event_end && new Date(event_end) < new Date(event_start)) {
        return reply.code(400).send({ error: "event_end is before event_start" });
      }

      // One statement, so one implicit transaction: a memory whose organizer
      // has no membership row would be invisible on their own main screen.
      // The organizer holding an ordinary row is what lets every later query
      // treat them as just another member.
      const [memory] = await sql<(Memory & { role: MemberRole })[]>`
        with created as (
          insert into memories (organizer_id, title, event_start, event_end)
          values (${request.user.id}, ${title.trim()}, ${event_start}, ${event_end ?? null})
          returning *
        ), member as (
          insert into memory_members (memory_id, user_id, role)
          select id, ${request.user.id}, 'organizer' from created
        )
        select created.*, 'organizer'::text as role from created
      `;
      if (!memory) throw new Error("insert into memories returned no row");
      // Empty rather than absent: the listing answers with exactly this shape,
      // and the client prepends what it just created to the list it holds.
      // A memory a moment old has no material, so there is nothing to sign.
      return reply.code(201).send({ ...memory, recent_thumbnail_urls: [] });
    },
  );

  // The main screen. The organizer has a memory_members row like everyone
  // else, so «organizer or member» needs no union — it is one join.
  app.get("/memories", { preHandler: app.authenticate }, async (request) => {
    // The card shows real frames from inside the memory, so the keys ride along
    // on the listing itself: this screen holds every memory one is in, and a
    // call per card to fetch them would be a round trip per card. Four is what
    // the card draws — enough of the material to speak for itself, so nothing
    // has to count the rest beside them.
    const rows = await sql<(Memory & { role: MemberRole; thumbnail_keys: string[] })[]>`
      select m.*, mm.role,
        array(
          select mi.thumbnail_key from media_items mi
          -- Ready and no earlier: the thumbnail key is the montage worker's to
          -- write, and before it there is nothing behind the column to sign.
          where mi.memory_id = m.id and mi.status = 'ready' and mi.thumbnail_key is not null
          -- The gallery's order (src/media/gallery.ts) read backwards: by when
          -- it was shot, falling back to arrival for a file that carries no
          -- date. «Последние кадры» must mean on the card what it means at the
          -- end of the gallery.
          order by coalesce(mi.captured_at, mi.created_at) desc, mi.id desc
          limit 4
        ) as thumbnail_keys
      from memory_members mm
      join memories m on m.id = mm.memory_id
      where mm.user_id = ${request.user.id}
      order by m.event_start desc, m.created_at desc
    `;

    // Signing is a local HMAC and not a request, so four per memory costs
    // nothing here. An unconfigured bucket is an empty tail rather than the
    // gallery's 503: there the links are the whole answer, here they are one
    // field of the main screen, which has to draw either way.
    const ttl = downloadTtlSeconds();
    const configured = storageConfigured();
    return Promise.all(
      rows.map(async ({ thumbnail_keys, ...memory }) => ({
        ...memory,
        recent_thumbnail_urls: configured
          ? await Promise.all(thumbnail_keys.map((key) => downloadUrl(key, ttl)))
          : [],
      })),
    );
  });
}
