import type { FastifyInstance } from "fastify";
import { sql } from "../db.ts";

/**
 * Лейблы — коробки с названием и цветом, по которым участник раскладывает кадры
 * воспоминания (doc-13). Общий лейбл видят все участники, личный — только
 * хозяин: ни названия, ни состава, ни следа в галерее.
 *
 * Здесь только чтение и приватность; завести лейбл, положить в него кадры,
 * переименовать и удалить — TASK-189.
 *
 * Приватность держится на одном предикате — «общий или мой», — и оба чтения
 * берут его отсюда, из `visibleLabels`. Скопировать его во второе место значит
 * однажды поправить одно и забыть другое, а цена такой забывчивости — чужой
 * личный лейбл на экране.
 *
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the membership
 * check this route hangs on.
 */

/** Строка списка. `mine` — «мой ли», то есть можно ли будет его править. */
export type LabelListItem = {
  id: string;
  title: string;
  color: number;
  shared: boolean;
  mine: boolean;
  media_count: number;
};

/**
 * Что спрашивающий вправе видеть: общие лейблы воспоминания и свои личные.
 * Чужие личные не приходят ни в списке, ни в подсчётах — их здесь попросту нет.
 */
const visibleLabels = (memoryId: string, userId: string) => sql`
  select l.* from labels l
  where l.memory_id = ${memoryId} and (l.shared or l.owner_id = ${userId})
`;

/**
 * Порядок один на оба чтения: сперва общие, внутри — по названию. Так строки
 * списка и `label_ids` кадра идут в одном и том же порядке, и клиенту не нужно
 * пересортировывать второе под первое. `id` в хвосте — чтобы тёзки не менялись
 * местами между запросами.
 */
const labelOrder = sql`order by l.shared desc, l.title, l.id`;

/**
 * Лейблы, в которых лежит кадр, — только видимые спрашивающему. Подставляется в
 * запрос галереи, где строка `media_items` ходит под псевдонимом `mi`.
 *
 * Подзапрос-массив, а не join: галерея — это список кадров, и кадр, лежащий в
 * трёх лейблах, должен прийти в ней один раз, а не трижды. Состав и порядок
 * галереи от лейблов не зависят вовсе.
 */
export const visibleLabelIds = (memoryId: string, userId: string) => sql`
  array(
    select l.id from label_media lm
    join (${visibleLabels(memoryId, userId)}) l on l.id = lm.label_id
    where lm.media_id = mi.id
    ${labelOrder}
  )
`;

export function labelRoutes(app: FastifyInstance) {
  // Лист «В лейбл» (design/screens/SheetLabels.html). Читает любой участник,
  // `viewer` в том числе: свои личные коробки есть у каждого, кто стоит в
  // воспоминании, а общие — часть того же экрана. Не участник сюда не доходит —
  // проверка членства ответила ему 404.
  app.get<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/labels",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request) => {
      const userId = request.user.id;
      // `media_count` считается по связям, а не по кадрам: удалённый кадр уносит
      // свою связь каскадом (миграция 100), поэтому число всегда равно тому, что
      // в коробке лежит на самом деле. `::int` — иначе count() приходит bigint,
      // то есть строкой, и «23 кадра» нечем сравнить с «12».
      return sql<LabelListItem[]>`
        select l.id, l.title, l.color, l.shared,
          l.owner_id = ${userId} as mine,
          (select count(*)::int from label_media lm where lm.label_id = l.id) as media_count
        from (${visibleLabels(request.membership.memory.id, userId)}) l
        ${labelOrder}
      `;
    },
  );
}
