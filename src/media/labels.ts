import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TransactionSql } from "postgres";
import { sql } from "../db.ts";
import {
  lowerIds,
  type MemberRole,
  mediaIdsSchema,
  seenBy,
  uuidPattern,
} from "../memories/plugin.ts";
import type { LabelListItem } from "../types/media.ts";

export type { LabelListItem };

type LabelRow = {
  id: string;
  owner_id: string;
  shared: boolean;
};
type Caller = {
  id: string;
  role: MemberRole;
};
const visibleLabels = (memoryId: string, userId: string) => sql`
  select l.* from labels l
  where l.memory_id = ${memoryId} and (l.shared or l.owner_id = ${userId})
`;
const labelOrder = sql`order by l.shared desc, l.title, l.id`;
export const visibleLabelIds = (memoryId: string, userId: string) => sql`
  array(
    select l.id from label_media lm
    join (${visibleLabels(memoryId, userId)}) l on l.id = lm.label_id
    where lm.media_id = mi.id
    ${labelOrder}
  )
`;
type LabelWrite = "create" | "change";
function labelDenial(
  write: LabelWrite,
  label: {
    owner_id: string;
    shared: boolean;
  },
  caller: Caller,
): 403 | 404 | null {
  if (!label.shared) return label.owner_id === caller.id ? null : 404;
  return write === "create" && caller.role === "viewer" ? 403 : null;
}
export const handOverLabels = (
  tx: TransactionSql,
  memoryId: string,
  leaving: string,
  organizerId: string,
) => tx`
  with gone as (
    delete from labels
    where memory_id = ${memoryId} and owner_id = ${leaving} and not shared
  )
  update labels set owner_id = ${organizerId}, updated_at = now()
  where memory_id = ${memoryId} and owner_id = ${leaving} and shared
`;
type LabelFilter = {
  labelId?: string;
  mediaId?: string;
};
export async function labelCards(
  memoryId: string,
  caller: Caller,
  { labelId, mediaId }: LabelFilter = {},
): Promise<LabelListItem[]> {
  type Row = LabelRow & {
    title: string;
    color: number;
    media_count: number;
  };
  const rows = await sql<Row[]>`
    select l.id, l.title, l.color, l.shared, l.owner_id,
      (select count(*)::int from label_media lm
        join media_items mi on mi.id = lm.media_id
        where lm.label_id = l.id and ${seenBy("mi", caller.id)}) as media_count
    from (${visibleLabels(memoryId, caller.id)}) l
    where (${labelId ?? null}::uuid is null or l.id = ${labelId ?? null}::uuid)
      and (${mediaId ?? null}::uuid is null or exists (
        select 1 from label_media lm where lm.label_id = l.id and lm.media_id = ${mediaId ?? null}::uuid
      ))
    ${labelOrder}
  `;
  return rows.map(({ owner_id, ...label }) => {
    const writable = labelDenial("change", { owner_id, shared: label.shared }, caller) === null;
    return {
      ...label,
      mine: owner_id === caller.id,
      can_edit: writable,
      can_add_media: writable,
    };
  });
}
async function labelCard(memoryId: string, caller: Caller, labelId: string) {
  const [card] = await labelCards(memoryId, caller, { labelId });
  if (!card) throw new Error("the written label is not in its own author's list");
  return card;
}
async function missingFrames(memoryId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = await sql<
    {
      id: string;
    }[]
  >`
    select id from media_items
    where memory_id = ${memoryId} and status <> 'pending_upload' and id in ${sql(ids)}
  `;
  const known = new Set(found.map((row) => row.id));
  return ids.filter((id) => !known.has(id));
}
const putFrames = (
  db: typeof sql | TransactionSql,
  labelId: string,
  memoryId: string,
  addedBy: string,
  ids: string[],
) => db`
  insert into label_media (label_id, media_id, memory_id, added_by)
  select ${labelId}, id, ${memoryId}, ${addedBy} from media_items
  where memory_id = ${memoryId} and status <> 'pending_upload' and id in ${db(ids)}
  on conflict do nothing
`;
export function labelRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const forbidden = { error: "forbidden" };
  const deny = (reply: FastifyReply, code: 403 | 404) =>
    reply.code(code).send(code === 404 ? notFound : forbidden);
  const mediaIds = { ...mediaIdsSchema(), minItems: 1 } as const;
  const labelFields = {
    title: { type: "string", pattern: "\\S", maxLength: 100 },
    color: { type: "integer", minimum: 1, maximum: 8 },
  } as const;
  const createBody = {
    type: "object",
    required: ["title", "color", "shared"],
    additionalProperties: false,
    properties: {
      ...labelFields,
      shared: { type: "boolean" },
      media_ids: mediaIds,
    },
  } as const;
  const editBody = {
    type: "object",
    minProperties: 1,
    additionalProperties: false,
    properties: labelFields,
  } as const;
  const mediaBody = {
    type: "object",
    required: ["media_ids"],
    additionalProperties: false,
    properties: { media_ids: mediaIds },
  } as const;
  const writableLabel = async (
    request: FastifyRequest<{
      Params: {
        memoryId: string;
        labelId: string;
      };
    }>,
    reply: FastifyReply,
  ) => {
    const { memory, role } = request.membership;
    const caller = { id: request.user.id, role };
    const { labelId } = request.params;
    const [label] = uuidPattern.test(labelId)
      ? await sql<LabelRow[]>`
          select id, owner_id, shared from labels where id = ${labelId} and memory_id = ${memory.id}
        `
      : [];
    const denied = label ? labelDenial("change", label, caller) : 404;
    if (!label || denied) {
      deny(reply, denied ?? 404);
      return null;
    }
    return { memory, caller, label };
  };
  app.get<{
    Params: {
      memoryId: string;
    };
  }>(
    "/memories/:memoryId/labels",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request) => {
      const { memory, role } = request.membership;
      return labelCards(memory.id, { id: request.user.id, role });
    },
  );
  app.post<{
    Params: {
      memoryId: string;
    };
    Body: {
      title: string;
      color: number;
      shared: boolean;
      media_ids?: string[];
    };
  }>(
    "/memories/:memoryId/labels",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: createBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const caller = { id: request.user.id, role };
      const { title, color, shared } = request.body;
      const denied = labelDenial("create", { owner_id: caller.id, shared }, caller);
      if (denied) return deny(reply, denied);
      const ids = lowerIds(request.body.media_ids);
      const missing = await missingFrames(memory.id, ids);
      if (missing.length > 0) {
        return reply.code(400).send({ error: "no such media in this memory", media_ids: missing });
      }
      const id = await sql.begin(async (tx) => {
        const [label] = await tx<
          {
            id: string;
          }[]
        >`
          insert into labels (memory_id, owner_id, title, color, shared)
          values (${memory.id}, ${caller.id}, ${title.trim()}, ${color}, ${shared})
          returning id
        `;
        if (!label) throw new Error("insert into labels returned no row");
        if (ids.length > 0) await putFrames(tx, label.id, memory.id, caller.id, ids);
        return label.id;
      });
      return reply.code(201).send(await labelCard(memory.id, caller, id));
    },
  );
  app.patch<{
    Params: {
      memoryId: string;
      labelId: string;
    };
    Body: {
      title?: string;
      color?: number;
    };
  }>(
    "/memories/:memoryId/labels/:labelId",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: editBody } },
    async (request, reply) => {
      const held = await writableLabel(request, reply);
      if (!held) return reply;
      const { memory, caller, label } = held;
      const { title, color } = request.body;
      await sql`
        update labels
        set title = coalesce(${title?.trim() ?? null}, title),
          color = coalesce(${color ?? null}, color), updated_at = now()
        where id = ${label.id}
      `;
      return labelCard(memory.id, caller, label.id);
    },
  );
  app.delete<{
    Params: {
      memoryId: string;
      labelId: string;
    };
  }>(
    "/memories/:memoryId/labels/:labelId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const held = await writableLabel(request, reply);
      if (!held) return reply;
      await sql`delete from labels where id = ${held.label.id}`;
      return { ok: true };
    },
  );
  app.post<{
    Params: {
      memoryId: string;
      labelId: string;
    };
    Body: {
      media_ids: string[];
    };
  }>(
    "/memories/:memoryId/labels/:labelId/media",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: mediaBody } },
    async (request, reply) => {
      const held = await writableLabel(request, reply);
      if (!held) return reply;
      const { memory, caller, label } = held;
      const ids = lowerIds(request.body.media_ids);
      const missing = await missingFrames(memory.id, ids);
      if (missing.length > 0) {
        return reply.code(400).send({ error: "no such media in this memory", media_ids: missing });
      }
      await putFrames(sql, label.id, memory.id, caller.id, ids);
      return labelCard(memory.id, caller, label.id);
    },
  );
  app.delete<{
    Params: {
      memoryId: string;
      labelId: string;
    };
    Body: {
      media_ids: string[];
    };
  }>(
    "/memories/:memoryId/labels/:labelId/media",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: mediaBody } },
    async (request, reply) => {
      const held = await writableLabel(request, reply);
      if (!held) return reply;
      const { memory, caller, label } = held;
      const ids = lowerIds(request.body.media_ids);
      await sql`
        delete from label_media where label_id = ${label.id} and media_id in ${sql(ids)}
      `;
      return labelCard(memory.id, caller, label.id);
    },
  );
}
