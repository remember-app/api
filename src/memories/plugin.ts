import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { sql } from "../db.ts";
import { downloadTtlSeconds, memoryMaxFiles } from "../media/config.ts";
import { downloadUrl, storageConfigured } from "../media/r2.ts";
export type MemberRole = "organizer" | "contributor" | "viewer";
export type ContributionStatus = "not_started" | "more_coming" | "done" | "nothing";
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
  cover_media_id: string | null;
};
declare module "fastify" {
  interface FastifyInstance {
    requireMembership: preHandlerAsyncHookHandler;
  }
  interface FastifyRequest {
    membership: {
      memory: Memory;
      role: MemberRole;
      status: ContributionStatus;
    };
  }
}
export const uuidPattern = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
export const mediaIdsSchema = () =>
  ({
    type: "array",
    items: { type: "string", pattern: uuidPattern.source },
    uniqueItems: true,
    maxItems: memoryMaxFiles(),
  }) as const;
export const lowerIds = (ids: string[] = []) => [...new Set(ids.map((id) => id.toLowerCase()))];
export const seenBy = (frame: string, userId: string) =>
  sql`(not ${sql(frame)}.hidden or ${sql(frame)}.uploaded_by = ${userId})`;
export const inSight = (frame: string, userId: string) =>
  sql`${sql(frame)}.status <> 'pending_upload' and ${seenBy(frame, userId)}`;
const memoryFields = {
  title: { type: "string", pattern: "\\S", maxLength: 200 },
  event_start: { type: "string", format: "date-time" },
  event_end: { type: ["string", "null"], format: "date-time" },
} as const;
const createBody = {
  type: "object",
  required: ["title", "event_start"],
  additionalProperties: false,
  properties: memoryFields,
} as const;
const editFields = {
  ...memoryFields,
  cover_media_id: { type: ["string", "null"], pattern: uuidPattern.source },
} as const;
const editBody = {
  type: "object",
  anyOf: Object.keys(editFields).map((field) => ({ required: [field] })),
  additionalProperties: false,
  properties: editFields,
} as const;
export function memoriesPlugin(app: FastifyInstance) {
  app.decorate("requireMembership", async (request, reply) => {
    if (!request.user) {
      throw new Error("app.requireMembership must be mounted after app.authenticate");
    }
    const { memoryId } = request.params as {
      memoryId?: string;
    };
    const notFound = () => reply.code(404).send({ error: "not found" });
    if (!memoryId || !uuidPattern.test(memoryId)) return notFound();
    const [row] = await sql<
      (Memory & {
        role: MemberRole;
        status: ContributionStatus;
      })[]
    >`
      select m.*, mm.role, mm.status
      from memory_members mm
      join memories m on m.id = mm.memory_id
      where mm.memory_id = ${memoryId} and mm.user_id = ${request.user.id}
    `;
    if (!row) return notFound();
    const { role, status, ...memory } = row;
    request.membership = { memory, role, status };
  });
  app.post<{
    Body: {
      title: string;
      event_start: string;
      event_end?: string | null;
    };
  }>(
    "/memories",
    { preHandler: app.authenticate, schema: { body: createBody } },
    async (request, reply) => {
      const { title, event_start, event_end } = request.body;
      if (event_end && new Date(event_end) < new Date(event_start)) {
        return reply.code(400).send({ error: "event_end is before event_start" });
      }
      const [memory] = await sql<
        (Memory & {
          role: MemberRole;
        })[]
      >`
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
      return reply.code(201).send({
        ...memory,
        removal_media_count: 0,
        cover_thumbnail_url: null,
        recent_thumbnail_urls: [],
        card_thumbnail_urls: [],
        member_count: 1,
        contributed_member_count: 0,
      });
    },
  );
  app.get("/memories", { preHandler: app.authenticate }, (request) => cards(request.user.id));
  app.patch<{
    Params: {
      memoryId: string;
    };
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
      if (role !== "organizer") return reply.code(403).send({ error: "forbidden" });
      const body = request.body;
      const title = body.title === undefined ? memory.title : body.title.trim();
      const eventStart = body.event_start ?? memory.event_start;
      const eventEnd = body.event_end === undefined ? memory.event_end : body.event_end;
      if (eventEnd && new Date(eventEnd) < new Date(eventStart)) {
        return reply.code(400).send({ error: "event_end is before event_start" });
      }
      const cover = body.cover_media_id === undefined ? memory.cover_media_id : body.cover_media_id;
      if (body.cover_media_id) {
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
      const [card] = await cards(request.user.id, memory.id);
      if (!card) throw new Error("the edited memory is not in its own organizer's listing");
      return card;
    },
  );
}
const CARD_WINDOW_MS = 5 * 60 * 60 * 1000;
const cardWindow = () => Math.floor(Date.now() / CARD_WINDOW_MS);
export async function cards(userId: string, memoryId?: string) {
  type Row = Memory & {
    role: MemberRole;
    thumbnail_keys: string[];
    card_thumbnail_keys: string[];
    cover_thumbnail_key: string | null;
    member_count: number;
    contributed_member_count: number;
    seen_media_count: number;
    removal_media_count: number | null;
  };
  const rows = await sql<Row[]>`
    select m.*, mm.role, counts.member_count, counts.contributed_member_count,
      frames.seen as seen_media_count,
      case when mm.role = 'organizer' then frames.whole end as removal_media_count,
      -- The chosen frame, joined rather than fetched per card for the reason
      -- the tail below is: one answer holds the whole screen. Null both when
      -- no cover is chosen and — impossible for as long as only a ready frame
      -- can be chosen — when the one chosen has no derivative. Null as well to
      -- everyone but its owner once the frame is hidden: a cover is shown to
      -- the whole memory, which is exactly what hiding takes a frame out of.
      cover.thumbnail_key as cover_thumbnail_key,
      array(
        select mi.thumbnail_key from media_items mi
        -- Ready and no earlier: the thumbnail key is the montage worker's to
        -- write, and before it there is nothing behind the column to sign.
        where mi.memory_id = m.id and mi.status = 'ready' and mi.thumbnail_key is not null
          and ${seenBy("mi", userId)}
        -- The gallery's order (src/media/gallery.ts) read backwards: by when
        -- it was shot, falling back to arrival for a file that carries no
        -- date. «Последние кадры» must mean on the card what it means at the
        -- end of the gallery.
        order by coalesce(mi.captured_at, mi.created_at) desc, mi.id desc
        limit 4
      ) as thumbnail_keys,
      -- The main screen's own dozen: the same ready, seen frames, but drawn
      -- from the whole memory rather than read off its end. The order is seeded
      -- by the five-hour window (CARD_WINDOW_MS), not drawn afresh per answer:
      -- the phone re-reads this listing on every return to the main screen, and
      -- a fresh draw each time would change the card's face under the person's
      -- eyes. Inside a window the same frames come back in the same order; at
      -- its edge the seed changes and so do they. The hash sorts the lot before
      -- the ceiling cuts it, and the id breaks the tie two equal hashes would
      -- leave — the ceiling is well above what any card draws, so the screen is
      -- never short of material to pick from.
      array(
        select mi.thumbnail_key from media_items mi
        where mi.memory_id = m.id and mi.status = 'ready' and mi.thumbnail_key is not null
          and ${seenBy("mi", userId)}
        order by md5(mi.id::text || ${String(cardWindow())}), mi.id
        limit 12
      ) as card_thumbnail_keys
    from memory_members mm
    join memories m on m.id = mm.memory_id
    left join media_items cover on cover.id = m.cover_media_id and ${seenBy("cover", userId)}
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
    -- Frames with bytes behind them — the gallery leaves pending_upload out,
    -- and so does the counter a deletion moves — seen and whole in one pass.
    join lateral (
      select count(*) filter (where ${seenBy("mi", userId)})::int as seen,
        count(*)::int as whole
      from media_items mi
      where mi.memory_id = m.id and mi.status <> 'pending_upload'
    ) frames on true
    where mm.user_id = ${userId}
      -- One card or all of them, in one statement: the edit route answers
      -- with the row it just wrote, and it must be assembled by exactly the
      -- query the listing uses or the two shapes drift apart.
      and (${memoryId ?? null}::uuid is null or m.id = ${memoryId ?? null}::uuid)
    order by m.event_start desc, m.created_at desc
  `;
  const ttl = downloadTtlSeconds();
  const configured = storageConfigured();
  return Promise.all(
    rows.map(
      async ({
        thumbnail_keys,
        card_thumbnail_keys,
        cover_thumbnail_key,
        seen_media_count,
        ...memory
      }) => ({
        ...memory,
        media_count: seen_media_count,
        cover_thumbnail_url:
          configured && cover_thumbnail_key ? await downloadUrl(cover_thumbnail_key, ttl) : null,
        recent_thumbnail_urls: configured
          ? await Promise.all(thumbnail_keys.map((key) => downloadUrl(key, ttl)))
          : [],
        card_thumbnail_urls: configured
          ? await Promise.all(card_thumbnail_keys.map((key) => downloadUrl(key, ttl)))
          : [],
      }),
    ),
  );
}
