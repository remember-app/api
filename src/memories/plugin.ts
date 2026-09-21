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
  /**
   * The frame the organizer chose to stand for the memory, or null while they
   * have not — and null again the moment that frame is deleted, which the
   * database does itself (migration 100).
   */
  cover_media_id: string | null;
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

/**
 * What a memory is called and when it happened. One object rather than two
 * copies: the edit route takes the very same fields under the very same rules
 * — «с теми же проверками, что при создании» — and a rule written twice is a
 * rule that holds in one place and not the other.
 */
const memoryFields = {
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
} as const;

const createBody = {
  type: "object",
  required: ["title", "event_start"],
  additionalProperties: false,
  properties: memoryFields,
} as const;

const editBody = {
  type: "object",
  // Nothing is required — the screen sends what the organizer touched — but an
  // empty body is not an edit, and answering 200 to one would say it was.
  minProperties: 1,
  additionalProperties: false,
  properties: {
    ...memoryFields,
    // The cover, named by the id of a frame of this memory; `null` takes it
    // off. Spelled as a pattern and not `format: "uuid"` for the reason
    // `uuidPattern` gives — and `pattern` says nothing about `null`, which is
    // how both shapes pass one schema.
    cover_media_id: { type: ["string", "null"], pattern: uuidPattern.source },
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
      // Spelled out rather than absent: the listing answers with exactly this
      // shape, and the client prepends what it just created to the list it
      // holds. A memory a moment old has no material, so there is nothing to
      // sign — no tail and no cover — and exactly one member, its organizer,
      // who has brought nothing yet. Constants and not a second query: the
      // statement above is what made all of those true.
      return reply.code(201).send({
        ...memory,
        cover_thumbnail_url: null,
        recent_thumbnail_urls: [],
        member_count: 1,
        contributed_member_count: 0,
      });
    },
  );

  // The main screen. The organizer has a memory_members row like everyone
  // else, so «organizer or member» needs no union — it is one join.
  app.get("/memories", { preHandler: app.authenticate }, (request) => cards(request.user.id));

  // «Изменить название, даты и обложку» — one button on the settings screen
  // (design/screens/MemorySettings.html), so one route: what that form holds is
  // saved in one request. The organizer's alone — for everybody else the title
  // and the dates are something to read (doc-01).
  app.patch<{
    Params: { memoryId: string };
    Body: {
      title?: string;
      event_start?: string;
      event_end?: string | null;
      cover_media_id?: string | null;
    };
  }>(
    "/memories/:memoryId",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: editBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      // A member of another standing, not a stranger: the membership check
      // already answered a stranger with the house 404.
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });

      const body = request.body;
      // What the row will hold: an absent field keeps what is there, and an
      // `event_end` sent as null clears it. `??` would not tell those two
      // apart — null is a value here, not a missing one.
      const title = body.title === undefined ? memory.title : body.title.trim();
      const eventStart = body.event_start ?? memory.event_start;
      const eventEnd = body.event_end === undefined ? memory.event_end : body.event_end;
      // Checked against the window as it will be and not against what arrived:
      // moving only the start must still land it inside the end already stored.
      // Instants, not text, for the reason creating gives.
      if (eventEnd && new Date(eventEnd) < new Date(eventStart)) {
        return reply.code(400).send({ error: "event_end is before event_start" });
      }

      const cover = body.cover_media_id === undefined ? memory.cover_media_id : body.cover_media_id;
      // Only what arrived is checked — the cover already on the row was checked
      // when it was chosen, and nothing but deletion can unmake it since.
      if (body.cover_media_id) {
        // A frame of *this* memory that the worker has finished: before that
        // there is no derivative to draw the card with. Anything else — a
        // neighbour's frame, one still being processed, one that never existed
        // — is «no such frame», the same answer the download route gives for a
        // record whose bytes are not in the store yet (README, «404 один на
        // всех»).
        const [frame] = await sql`
          select 1 from media_items
          where id = ${body.cover_media_id} and memory_id = ${memory.id}
            and status = 'ready' and thumbnail_key is not null
        `;
        if (!frame) return reply.code(404).send({ error: "not found" });
      }

      await sql`
        update memories
        set title = ${title}, event_start = ${eventStart}, event_end = ${eventEnd},
          cover_media_id = ${cover}
        where id = ${memory.id}
      `;

      // Answered in the shape of the listing, as creating is: the screen that
      // sent this replaces the card it holds with what came back, counters and
      // frames included, without a second request.
      const [card] = await cards(request.user.id, memory.id);
      if (!card) throw new Error("the edited memory is not in its own organizer's listing");
      return card;
    },
  );
}

/**
 * The cards of the main screen — every memory the caller is in, or just the
 * one, which is what the edit route answers with.
 *
 * The card shows real frames from inside the memory, so the keys ride along on
 * the listing itself: this screen holds every memory one is in, and a call per
 * card to fetch them would be a round trip per card. Four is what the card
 * draws — enough of the material to speak for itself, so nothing has to count
 * the rest beside them.
 */
async function cards(userId: string, memoryId?: string) {
  type Row = Memory & {
    role: MemberRole;
    thumbnail_keys: string[];
    cover_thumbnail_key: string | null;
    member_count: number;
    contributed_member_count: number;
  };
  const rows = await sql<Row[]>`
    select m.*, mm.role, counts.member_count, counts.contributed_member_count,
      -- The chosen frame, joined rather than fetched per card for the reason
      -- the tail below is: one answer holds the whole screen. Null both when
      -- no cover is chosen and — impossible for as long as only a ready frame
      -- can be chosen — when the one chosen has no derivative.
      cover.thumbnail_key as cover_thumbnail_key,
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
    left join media_items cover on cover.id = m.cover_media_id
    -- «7 из 9 уже скинули свои кадры» on the card (doc-06): the whole roster
    -- of each memory, counted here rather than asked for per card — the
    -- screen holds every memory one is in, and the roster route
    -- (src/memories/members.ts) is one request per memory.
    -- Brought is done or nothing — the two answers that mean nobody is
    -- waiting on this member any more. more_coming is still material on the
    -- way, and not_started is no answer at all. Viewers fall out of both
    -- counts: they were never asked to bring anything, so counting them would
    -- hold the bar below full forever.
    -- Cast to int because count() is bigint, which postgres.js hands over as
    -- a string — the card would then draw «7» beside «9» and be unable to
    -- compare them.
    join lateral (
      select count(*)::int as member_count,
        count(*) filter (where roster.status in ('done', 'nothing'))::int
          as contributed_member_count
      from memory_members roster
      where roster.memory_id = m.id and roster.role <> 'viewer'
    ) counts on true
    where mm.user_id = ${userId}
      -- One card or all of them, in one statement: the edit route answers
      -- with the row it just wrote, and it must be assembled by exactly the
      -- query the listing uses or the two shapes drift apart.
      and (${memoryId ?? null}::uuid is null or m.id = ${memoryId ?? null}::uuid)
    order by m.event_start desc, m.created_at desc
  `;

  // Signing is a local HMAC and not a request, so four per memory costs
  // nothing here. An unconfigured bucket is an empty tail rather than the
  // gallery's 503: there the links are the whole answer, here they are one
  // field of the main screen, which has to draw either way.
  const ttl = downloadTtlSeconds();
  const configured = storageConfigured();
  return Promise.all(
    rows.map(async ({ thumbnail_keys, cover_thumbnail_key, ...memory }) => ({
      ...memory,
      // The cover goes out as a link to the derivative, exactly as the tail
      // does; null while none is chosen, which is the card drawn as it is
      // drawn today (doc-01).
      cover_thumbnail_url:
        configured && cover_thumbnail_key ? await downloadUrl(cover_thumbnail_key, ttl) : null,
      recent_thumbnail_urls: configured
        ? await Promise.all(thumbnail_keys.map((key) => downloadUrl(key, ttl)))
        : [],
    })),
  );
}
