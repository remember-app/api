import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "../db.ts";
import { inSight, uuidPattern } from "../memories/plugin.ts";

/**
 * Комментарии к кадру (doc-14, веха m-32). Участник подписывает кадр — свой или
 * чужой: что здесь происходит, кто в кадре, почему этот момент важен. Их читают
 * все участники воспоминания и — отдельно, в своём журнале — режиссёр монтажа.
 *
 * **Чтение — поле `comments` в `GET /memories/:memoryId/media/:mediaId`, а не
 * отдельный маршрут.** Комментарии рисуются на том же листе «Сведения о кадре»
 * (`design/screens/FrameInfo.html`), который открывается одним тапом по кадру:
 * человек, открывший кадр, видит и кадр, и подписи к нему, а второй запрос
 * означал бы, что панель открывается пустой и досыпается сверху — ровно то, чего
 * макет не рисует. Так же устроены лейблы кадра (миграция 120, TASK-473): они
 * приезжают в том же ответе. Маршрута `GET …/comments` нет и не нужно — читать
 * подписи в отрыве от кадра нечего.
 *
 * Права, решением человека (docs/media.md, «Кто что может»):
 *
 * - **читает любой участник, `viewer` в том числе** — комментарий виден всем,
 *   кто видит кадр, а кадр зритель видит;
 * - **пишет любой участник, `viewer` тоже** — он участник воспоминания, а не
 *   гость, и doc-14 («своему или чужому») их в этом не различает;
 * - **удаляет свой кто угодно из участников**, `viewer` в том числе;
 * - **чужой комментарий не удаляет никто, включая организатора.** Организатор
 *   распоряжается кадрами (`DELETE …/media/:mediaId`), но не чужими словами.
 *
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the membership
 * check these routes hang on.
 */

/** Строка комментария — ровно та, что приезжает в `FrameInfo`. */
export type FrameComment = {
  id: string;
  body: string;
  created_at: Date;
  /** Автор словами, как его называет список участников. */
  author: { id: string; username: string | null; name: string | null };
  /** Свой ли комментарий у спрашивающего: рисуется как «вы», и его можно снести. */
  mine: boolean;
};

/**
 * Потолок подписи. Человек пишет короткое: что здесь происходит и кто в кадре, а
 * не переписка о воспоминании (doc-14, «What it doesn't»). Полстраницы хватает
 * сказать всё, и режиссёру хватает прочитать.
 */
export const MAX_COMMENT_LENGTH = 500;

/**
 * Тело записи. `pattern` — поиск без якорей, то есть «есть хоть один непробельный
 * символ»: `minLength` пропустил бы «   », а `btrim` в `CHECK` базы такой текст
 * и вовсе не впустил бы. Пробелы по краям срезаются, как у названия воспоминания
 * и у названия лейбла.
 *
 * `additionalProperties` здесь отбрасывает незнакомое поле, а не отказывает
 * телу: у Fastify Ajv работает с `removeAdditional`, и лишнее просто не доедет
 * до запроса.
 */
const commentBody = {
  type: "object",
  required: ["body"],
  additionalProperties: false,
  properties: {
    body: { type: "string", pattern: "\\S", maxLength: MAX_COMMENT_LENGTH },
  },
} as const;

/**
 * Комментарии кадра по времени — тот же порядок для экрана и для режиссёра, и
 * `id` в хвосте, чтобы два комментария, пойманные в одну миллисекунду, не менялись
 * местами между запросами.
 *
 * Читает всю строку разом: подписи под одним кадром короткие, пагинации в макете
 * нет, а курсор здесь был бы лишней ручкой без потребителя.
 */
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
  // Право считается здесь, а не в запросе: правило одно на весь файл, и
  // переписанное вторым разом на SQL оно разошлось бы с тем, по которому
  // отказывает удаление. `author_id` дальше ответа не идёт — «можно ли мне» и так
  // сказано флагом, а экрану знать, кто именно, и так сказано именем.
  return rows.map(
    ({ author_id, author_username, author_name, ...comment }): FrameComment => ({
      ...comment,
      author: { id: author_id, username: author_username, name: author_name },
      mine: author_id === callerId,
    }),
  );
};

/**
 * Кадр, к которому путь ведёт, — если спрашивающий его вообще видит. Ответ один
 * и тот же на «нет такого», «чужое воспоминание», «ещё летит» и «скрыто хозяином»:
 * всё это про то, что кадра для спрашивающего нет, и различать их было бы ответом
 * на вопрос «а что там у людей?». Кривой id отсекается здесь же, а не схемой
 * параметров: та отвечала бы раньше проверки членства (docs/auth.md, «404 один на
 * всех»).
 */
async function seenFrame(memoryId: string, mediaId: string, callerId: string) {
  if (!uuidPattern.test(mediaId)) return null;
  const [frame] = await sql<{ id: string }[]>`
    select i.id from media_items i
    where i.id = ${mediaId} and i.memory_id = ${memoryId} and ${inSight("i", callerId)}
  `;
  return frame ?? null;
}

export function commentRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };

  /** Кадр из пути — если он есть и виден спрашивающему; иначе ответ уже отправлен. */
  const visibleFrame = async (
    request: FastifyRequest<{ Params: { memoryId: string; mediaId: string } }>,
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

  // Написать. Пишет любой участник, `viewer` тоже, и под чужим кадром это так же
  // законно, как под своим.
  //
  // Отвечает строкой списка, а не `{ok:true}`: панель дописывает приехавшее в
  // конец своего списка, и форма та же, что вернул бы `GET …/media/:mediaId` —
  // вторая вычитка тех же данных не нужна.
  app.post<{ Params: { memoryId: string; mediaId: string }; Body: { body: string } }>(
    "/memories/:memoryId/media/:mediaId/comments",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: commentBody } },
    async (request, reply) => {
      if (!(await visibleFrame(request, reply))) return reply;
      const { mediaId } = request.params;
      const memoryId = request.membership.memory.id;
      const authorId = request.user.id;

      const [comment] = await sql<{ id: string }[]>`
        insert into frame_comments (media_id, memory_id, author_id, body)
        values (${mediaId}, ${memoryId}, ${authorId}, ${request.body.body.trim()})
        returning id
      `;
      if (!comment) throw new Error("insert into frame_comments returned no row");

      const [written] = (await frameComments(memoryId, mediaId, authorId)).filter(
        (row) => row.id === comment.id,
      );
      // Только что записанная строка не может не найтись: единственный, кто мог бы
      // её снести между этими двумя запросами, — её же автор, а он и ждёт ответа.
      if (!written) throw new Error("the written comment is not in its own frame's list");
      return reply.code(201).send(written);
    },
  );

  // Снести свой. Чужой — `404`, а не `403`: «нельзя» было бы ответом о том, что
  // комментарий есть, а он и так на виду у всех участников. «Нет такого» честнее
  // и не даёт отличить удалённый от чужого — оба уже не на этом месте.
  app.delete<{ Params: { memoryId: string; mediaId: string; commentId: string } }>(
    "/memories/:memoryId/media/:mediaId/comments/:commentId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      if (!(await visibleFrame(request, reply))) return reply;
      const { mediaId, commentId } = request.params;
      const memoryId = request.membership.memory.id;
      // Кривой id — «нет такого», тем же ответом, что и несуществующий.
      if (!uuidPattern.test(commentId)) return reply.code(404).send(notFound);

      // Право на удаление — в самом `where`: между проверкой и записью ничто не
      // может подсунуть чужой комментарий. Проверки прав отдельной строкой здесь
      // нет намеренно — она была бы вторым местом, где написано одно и то же.
      const [gone] = await sql<{ id: string }[]>`
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
