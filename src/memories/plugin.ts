import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { sql } from "../db.ts";

/** The three levels architecture.md fixes; the matrix is in the README. */
export type MemberRole = "organizer" | "contributor" | "viewer";

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
    membership: { memory: Memory; role: MemberRole };
  }
}

/**
 * Spelled out rather than `format: "uuid"`, for the reason src/auth's session
 * params give: ajv's uuid format also passes a `urn:uuid:` prefix, which
 * Postgres cannot cast — that arrives as a 500.
 */
const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

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
    const [row] = await sql<(Memory & { role: MemberRole })[]>`
      select m.*, mm.role
      from memory_members mm
      join memories m on m.id = mm.memory_id
      where mm.memory_id = ${memoryId} and mm.user_id = ${request.user.id}
    `;
    if (!row) return notFound();

    const { role, ...memory } = row;
    request.membership = { memory, role };
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
      return reply.code(201).send(memory);
    },
  );

  // The main screen. The organizer has a memory_members row like everyone
  // else, so «organizer or member» needs no union — it is one join.
  app.get("/memories", { preHandler: app.authenticate }, async (request) => {
    return sql<(Memory & { role: MemberRole })[]>`
      select m.*, mm.role
      from memory_members mm
      join memories m on m.id = mm.memory_id
      where mm.user_id = ${request.user.id}
      order by m.event_start desc, m.created_at desc
    `;
  });
}
