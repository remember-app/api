import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "../db.ts";
import { inSight, uuidPattern } from "../memories/plugin.ts";
export type FrameComment = {
  id: string;
  body: string;
  created_at: Date;
  author: {
    id: string;
    username: string | null;
    name: string | null;
  };
  mine: boolean;
};
export const MAX_COMMENT_LENGTH = 500;
const commentBody = {
  type: "object",
  required: ["body"],
  additionalProperties: false,
  properties: {
    body: { type: "string", pattern: "\\S", maxLength: MAX_COMMENT_LENGTH },
  },
} as const;
export const frameComments = async (memoryId: string, mediaId: string, callerId: string) => {
  type Row = {
    id: string;
    body: string;
    created_at: Date;
    author_id: string;
    author_username: string | null;
    author_name: string | null;
  };
  const rows = await sql<Row[]>`
    select c.id, c.body, c.created_at,
      u.id as author_id, u.username as author_username, u.name as author_name
    from frame_comments c
    join users u on u.id = c.author_id
    where c.media_id = ${mediaId} and c.memory_id = ${memoryId}
    order by c.created_at, c.id
  `;
  return rows.map(
    ({ author_id, author_username, author_name, ...comment }): FrameComment => ({
      ...comment,
      author: { id: author_id, username: author_username, name: author_name },
      mine: author_id === callerId,
    }),
  );
};
async function seenFrame(memoryId: string, mediaId: string, callerId: string) {
  if (!uuidPattern.test(mediaId)) return null;
  const [frame] = await sql<
    {
      id: string;
    }[]
  >`
    select i.id from media_items i
    where i.id = ${mediaId} and i.memory_id = ${memoryId} and ${inSight("i", callerId)}
  `;
  return frame ?? null;
}
export function commentRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };
  const visibleFrame = async (
    request: FastifyRequest<{
      Params: {
        memoryId: string;
        mediaId: string;
      };
    }>,
    reply: FastifyReply,
  ) => {
    const frame = await seenFrame(
      request.membership.memory.id,
      request.params.mediaId,
      request.user.id,
    );
    if (!frame) {
      reply.code(404).send(notFound);
      return null;
    }
    return frame;
  };
  app.post<{
    Params: {
      memoryId: string;
      mediaId: string;
    };
    Body: {
      body: string;
    };
  }>(
    "/memories/:memoryId/media/:mediaId/comments",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: commentBody } },
    async (request, reply) => {
      if (!(await visibleFrame(request, reply))) return reply;
      const { mediaId } = request.params;
      const memoryId = request.membership.memory.id;
      const authorId = request.user.id;
      const [comment] = await sql<
        {
          id: string;
        }[]
      >`
        insert into frame_comments (media_id, memory_id, author_id, body)
        values (${mediaId}, ${memoryId}, ${authorId}, ${request.body.body.trim()})
        returning id
      `;
      if (!comment) throw new Error("insert into frame_comments returned no row");
      const [written] = (await frameComments(memoryId, mediaId, authorId)).filter(
        (row) => row.id === comment.id,
      );
      if (!written) throw new Error("the written comment is not in its own frame's list");
      return reply.code(201).send(written);
    },
  );
  app.delete<{
    Params: {
      memoryId: string;
      mediaId: string;
      commentId: string;
    };
  }>(
    "/memories/:memoryId/media/:mediaId/comments/:commentId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!(await visibleFrame(request, reply))) return reply;
      const { mediaId, commentId } = request.params;
      const memoryId = request.membership.memory.id;
      if (!uuidPattern.test(commentId)) return reply.code(404).send(notFound);
      const [gone] = await sql<
        {
          id: string;
        }[]
      >`
        delete from frame_comments
        where id = ${commentId} and media_id = ${mediaId} and memory_id = ${memoryId}
          and author_id = ${request.user.id}
        returning id
      `;
      if (!gone) return reply.code(404).send(notFound);
      return { ok: true };
    },
  );
}
