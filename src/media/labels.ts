import type { FastifyInstance, FastifyReply } from "fastify";
import type { TransactionSql } from "postgres";
import { sql } from "../db.ts";
import { type MemberRole, uuidPattern } from "../memories/plugin.ts";
import { memoryMaxFiles } from "./config.ts";

/**
 * Лейблы — коробки с названием и цветом, по которым участник раскладывает кадры
 * воспоминания (doc-13). Общий лейбл видят все участники, личный — только
 * хозяин: ни названия, ни состава, ни следа в галерее.
 *
 * Здесь всё, что с лейблом делают: список, кто что может, завести (можно сразу
 * с кадрами), положить кадры пачкой, убрать пачкой, переименовать, перекрасить,
 * удалить — и что становится с лейблами ушедшего участника
 * (`handOverLabels`, зовётся из src/memories/members.ts).
 *
 * Приватность держится на одном предикате — «общий или мой», — и оба чтения
 * берут его отсюда, из `visibleLabels`. Скопировать его во второе место значит
 * однажды поправить одно и забыть другое, а цена такой забывчивости — чужой
 * личный лейбл на экране.
 *
 * Права держатся так же — на одной `labelDenial`, и её же спрашивает список,
 * чтобы экран не повторял правило у себя.
 *
 * Mounted from `buildApp` after `memoriesPlugin`, which decorates the membership
 * check these routes hang on.
 */

/**
 * Строка списка. `mine` — «завёл ли его спрашивающий»; что ему при этом
 * **можно**, говорят `can_edit` и `can_add_media`, и говорит их правило прав, а
 * не звание владельца: общий лейбл правит любой участник, а не только тот, кто
 * его завёл.
 */
export type LabelListItem = {
  id: string;
  title: string;
  color: number;
  shared: boolean;
  mine: boolean;
  /** Переименовать, перекрасить, удалить. */
  can_edit: boolean;
  /** Положить в него кадры. */
  can_add_media: boolean;
  media_count: number;
};

/** Лейбл ровно теми полями, по которым решается, что с ним можно. */
type LabelRow = { id: string; owner_id: string; shared: boolean };

/** Спрашивающий: кто он и кем стоит в этом воспоминании. */
type Caller = { id: string; role: MemberRole };

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

/**
 * Что с лейблом делают: завести его — или писать в заведённый (положить и
 * убрать кадры, переименовать, перекрасить, удалить: право на всё это одно).
 */
type LabelWrite = "create" | "change";

/**
 * Кто что может с лейблом — правило целиком, решением человека (decision-12):
 * «права на лейбл общие — могу изменять все, личные только человек» и про
 * зрителя — «заводить не даём — у него только просмотр». Его спрашивают и все
 * маршруты записи, и флаги `can_edit`/`can_add_media` в списке, чтобы экран не
 * повторял правило у себя. Те же слова — в README, «Лейблы — как это устроено».
 *
 * - личный лейбл — только хозяина; всем остальным, организатору тоже, его нет;
 * - общий лейбл пишет любой участник, зритель тоже, кто бы его ни завёл и кто бы
 *   ни положил в него кадр;
 * - завести общий лейбл зритель не может, личный — может.
 *
 * Отвечает кодом отказа, а не словом: маршруту остаётся отдать его тем же
 * телом, каким это семейство отказывает всегда.
 */
function labelDenial(
  write: LabelWrite,
  label: { owner_id: string; shared: boolean },
  caller: Caller,
): 403 | 404 | null {
  // Чужому личный лейбл — `404`, а не `403`: «нельзя» было бы ответом о том,
  // что он существует.
  if (!label.shared) return label.owner_id === caller.id ? null : 404;
  return write === "create" && caller.role === "viewer" ? 403 : null;
}

/**
 * Что становится с лейблами участника, когда он уходит или его исключают.
 * Личные уходят с ним — их всё равно никто больше не видел; общие остаются
 * стоять, потому что ими пользовалось всё воспоминание, и хозяином им
 * становится организатор. Кадры при этом живут по своему правилу
 * (`removeMedia`): принесённые ушедшим удаляются и пропадают из всех лейблов
 * каскадом, чужие кадры в его коробках остаются на месте.
 *
 * Одним запросом и внутри транзакции звавшего — той же, в которой уходит строка
 * `memory_members`: воспоминание с лейблом, у которого хозяина в нём уже нет,
 * никому не показывается даже на миг.
 */
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

/**
 * Лейблы воспоминания глазами спрашивающего — весь список или один названный,
 * одним запросом на оба случая: маршруты записи отвечают той же строкой, что
 * приходит в списке, и собирать её вторым способом значит однажды разойтись.
 *
 * `media_count` считается по связям, а не по кадрам: удалённый кадр уносит свою
 * связь каскадом (миграция 120), поэтому число всегда равно тому, что в коробке
 * лежит на самом деле. `::int` — иначе count() приходит bigint, то есть строкой,
 * и «23 кадра» нечем сравнить с «12».
 */
async function labelCards(
  memoryId: string,
  caller: Caller,
  labelId: string | null = null,
): Promise<LabelListItem[]> {
  type Row = LabelRow & { title: string; color: number; media_count: number };
  const rows = await sql<Row[]>`
    select l.id, l.title, l.color, l.shared, l.owner_id,
      (select count(*)::int from label_media lm where lm.label_id = l.id) as media_count
    from (${visibleLabels(memoryId, caller.id)}) l
    where ${labelId}::uuid is null or l.id = ${labelId}::uuid
    ${labelOrder}
  `;
  // Права считаются здесь, а не в запросе: правило одно на весь файл, и
  // переписанное вторым разом на SQL оно разошлось бы с тем, по которому
  // отказывают маршруты. `owner_id` дальше списка не идёт — кто завёл общий
  // лейбл, экрану знать незачем, ему нужно «можно ли мне».
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

/** Тот же ответ, что и у списка, но об одном лейбле — им отвечает каждая запись. */
async function labelCard(memoryId: string, caller: Caller, labelId: string) {
  const [card] = await labelCards(memoryId, caller, labelId);
  // Невидимым себе лейбл записавшего быть не может: чужой личный до записи не
  // допущен вовсе, а общий и свой личный он видит.
  if (!card) throw new Error("the written label is not in its own author's list");
  return card;
}

/**
 * Пачка к виду, в котором с ней можно работать: нижним регистром и без
 * повторов. Postgres отдаёт uuid маленькими буквами, поэтому клиент, отправивший
 * свой же id заглавными, не должен услышать «нет такого кадра»; а `uniqueItems`
 * схемы сравнивает строки как они пришли, так что один кадр, названный дважды в
 * двух написаниях, её проходит.
 */
const lower = (ids: string[] = []) => [...new Set(ids.map((id) => id.toLowerCase()))];

/**
 * Чего из пачки в этом воспоминании нет. Кадр соседнего воспоминания, кадр,
 * которого не было вовсе, и кадр, который ещё грузится, — одно и то же «нет
 * такого кадра»: лейблы раскладывают галерею, а галерея показывает ровно то,
 * что уже в хранилище (`status <> 'pending_upload'`).
 */
async function missingFrames(memoryId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = await sql<{ id: string }[]>`
    select id from media_items
    where memory_id = ${memoryId} and status <> 'pending_upload' and id in ${sql(ids)}
  `;
  const known = new Set(found.map((row) => row.id));
  return ids.filter((id) => !known.has(id));
}

/**
 * Положить пачку в коробку. Одним запросом, и кадры для него отбирает сам
 * Postgres — то есть ничто между проверкой и записью не может подсунуть сюда
 * кадр чужого воспоминания. Уже лежащий кадр не ошибка и не дубль: `on conflict
 * do nothing` — это «он уже там», а не «не вышло».
 *
 * `added_by` — записанный факт, кто положил кадр; правило прав его не
 * спрашивает.
 */
const putFrames = (
  // Тем же запросом и в одиночку, и внутри транзакции создания лейбла: у
  // postgres.js это два разных типа, хотя запрос для них один и тот же.
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

  /** Приговор правила прав — ответом маршрута, тем же телом, что у соседей. */
  const deny = (reply: FastifyReply, code: 403 | 404) =>
    reply.code(code).send(code === 404 ? notFound : forbidden);

  /**
   * Пачка кадров: тем же описанием, что у заказа ролика
   * (src/montages/montages.ts), и по тем же причинам. Только uuid — маршрут
   * кладёт их прямо в `where id in (…)` по uuid-колонке, где «не uuid» это
   * ошибка базы, а не `400`. Потолок — файловый предел самого воспоминания:
   * пачка длиннее, чем воспоминание вмещает файлов, называет что-то дважды или
   * является мусором. Собрано при регистрации, а не в обработчике: ajv
   * компилирует схему один раз, и число должно стоять в ней к этому моменту.
   */
  const mediaIds = {
    type: "array",
    items: { type: "string", pattern: uuidPattern.source },
    // Пустая пачка — не действие: отвечать на неё `200` значило бы сказать, что
    // что-то положено.
    minItems: 1,
    uniqueItems: true,
    maxItems: memoryMaxFiles(),
  } as const;

  /**
   * Что у лейбла можно написать. `pattern` — это поиск без якорей, то есть
   * «есть хотя бы один непробельный символ»: `minLength` пропустил бы «   ».
   * Цвет — номер ячейки палитры, ровно восемь (design/screens/SheetLabelNew.html),
   * и тот же предел стоит в базе `CHECK`-ом; здесь он превращается в `400`
   * вместо `500`.
   */
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
      // Необязательные: «Новый лейбл» заводят и пустым, из листа фильтров, и
      // сразу с отмеченными кадрами — «Создать и положить 4 кадра».
      media_ids: mediaIds,
    },
  } as const;

  /**
   * Ни `shared`, ни `media_ids`: общий ↔ личный после создания не
   * переключается — макет этого не рисует, а перевод общего в личный спрятал бы
   * от всех чужие кадры, которые в нём лежат. Кадры кладут и убирают свои
   * маршруты. Пустое тело — не правка, и `200` на него сказал бы, что она была.
   *
   * Ajv у Fastify работает с `removeAdditional`, поэтому `additionalProperties`
   * здесь отбрасывает незнакомое поле, а не отказывает телу: присланный `shared`
   * просто не доедет до запроса, и лейбл останется каким был.
   */
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

  /**
   * Лейбл этого воспоминания по id из пути. Правам он не судья — их спрашивают
   * у `labelDenial` в самом маршруте; здесь только «есть ли такая строка».
   */
  const held = async (reply: FastifyReply, memoryId: string, labelId: string) => {
    // «Не uuid» — это «нет такого лейбла», домашнее правило семейства (README,
    // «404 один на всех»), и проверка стоит здесь, а не схемой параметров: та
    // отвечает раньше проверки членства и сказала бы `400` снаружи
    // воспоминания.
    if (!uuidPattern.test(labelId)) {
      reply.code(404).send(notFound);
      return null;
    }
    const [label] = await sql<(LabelRow & { title: string; color: number })[]>`
      select id, owner_id, shared, title, color from labels
      where id = ${labelId} and memory_id = ${memoryId}
    `;
    // Лейбл соседнего воспоминания — это «нет такого лейбла» ровно по той же
    // причине, по которой соседнее воспоминание — «нет такого воспоминания».
    if (!label) reply.code(404).send(notFound);
    return label ?? null;
  };

  // Лист «В лейбл» (design/screens/SheetLabels.html). Читает любой участник,
  // `viewer` в том числе: свои личные коробки есть у каждого, кто стоит в
  // воспоминании, а общие — часть того же экрана. Не участник сюда не доходит —
  // проверка членства ответила ему 404.
  app.get<{ Params: { memoryId: string } }>(
    "/memories/:memoryId/labels",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request) => {
      const { memory, role } = request.membership;
      return labelCards(memory.id, { id: request.user.id, role });
    },
  );

  // «Новый лейбл» (design/screens/SheetLabelNew.html) — и сразу с кадрами, если
  // его заводят из режима выбора: кнопка на том листе так и называется,
  // «Создать и положить 4 кадра».
  app.post<{
    Params: { memoryId: string };
    Body: { title: string; color: number; shared: boolean; media_ids?: string[] };
  }>(
    "/memories/:memoryId/labels",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: createBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const caller = { id: request.user.id, role };
      const { title, color, shared } = request.body;
      const denied = labelDenial("create", { owner_id: caller.id, shared }, caller);
      if (denied) return deny(reply, denied);

      const ids = lower(request.body.media_ids);
      const missing = await missingFrames(memory.id, ids);
      if (missing.length > 0) {
        return reply.code(400).send({ error: "no such media in this memory", media_ids: missing });
      }

      // Одной транзакцией: лейбл и его кадры появляются вместе или не
      // появляются вовсе — полупустая коробка на экране означала бы, что часть
      // отмеченных кадров тихо не легла.
      const id = await sql.begin(async (tx) => {
        const [label] = await tx<{ id: string }[]>`
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

  // Переименовать и перекрасить. Отвечает строкой списка, как и всякая запись
  // здесь: лист, с которого её правили, заменяет свою строку тем, что пришло.
  app.patch<{
    Params: { memoryId: string; labelId: string };
    Body: { title?: string; color?: number };
  }>(
    "/memories/:memoryId/labels/:labelId",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: editBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const caller = { id: request.user.id, role };
      const label = await held(reply, memory.id, request.params.labelId);
      if (!label) return reply;
      const denied = labelDenial("change", label, caller);
      if (denied) return deny(reply, denied);

      const { title, color } = request.body;
      // Чего не прислали, то остаётся как было: экран шлёт то, что человек
      // тронул.
      await sql`
        update labels
        set title = ${title === undefined ? label.title : title.trim()},
          color = ${color ?? label.color}, updated_at = now()
        where id = ${label.id}
      `;
      return labelCard(memory.id, caller, label.id);
    },
  );

  // Удалить коробку. Связи уходят с ней каскадом (миграция 120), а кадры — нет:
  // они лежат в воспоминании и в галерее ровно там же, где лежали.
  app.delete<{ Params: { memoryId: string; labelId: string } }>(
    "/memories/:memoryId/labels/:labelId",
    { preHandler: [app.authenticate, app.requireMembership] },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const label = await held(reply, memory.id, request.params.labelId);
      if (!label) return reply;
      const denied = labelDenial("change", label, { id: request.user.id, role });
      if (denied) return deny(reply, denied);

      await sql`delete from labels where id = ${label.id}`;
      return { ok: true };
    },
  );

  // Положить отмеченные кадры пачкой — то самое действие, ради которого лист
  // открывают из режима выбора.
  app.post<{ Params: { memoryId: string; labelId: string }; Body: { media_ids: string[] } }>(
    "/memories/:memoryId/labels/:labelId/media",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: mediaBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const caller = { id: request.user.id, role };
      const label = await held(reply, memory.id, request.params.labelId);
      if (!label) return reply;
      const denied = labelDenial("change", label, caller);
      if (denied) return deny(reply, denied);

      const ids = lower(request.body.media_ids);
      // Вся пачка или ничего: кадр соседнего воспоминания или несуществующий —
      // это ошибка клиента целиком, а не повод положить остальные и промолчать
      // о нём. Отвечаем, какие именно, как отвечает заказ ролика.
      const missing = await missingFrames(memory.id, ids);
      if (missing.length > 0) {
        return reply.code(400).send({ error: "no such media in this memory", media_ids: missing });
      }

      await putFrames(sql, label.id, memory.id, caller.id, ids);
      return labelCard(memory.id, caller, label.id);
    },
  );

  // Убрать кадры из коробки — повторный тап по той же строке листа. Сами кадры
  // остаются в галерее на своих местах: убирают из лейбла, а не из
  // воспоминания. Кадр, которого в коробке и не было, — не ошибка: убирать
  // нечего, как не ошибка и положить уже лежащее.
  app.delete<{ Params: { memoryId: string; labelId: string }; Body: { media_ids: string[] } }>(
    "/memories/:memoryId/labels/:labelId/media",
    { preHandler: [app.authenticate, app.requireMembership], schema: { body: mediaBody } },
    async (request, reply) => {
      const { memory, role } = request.membership;
      const caller = { id: request.user.id, role };
      const label = await held(reply, memory.id, request.params.labelId);
      if (!label) return reply;
      const denied = labelDenial("change", label, caller);
      if (denied) return deny(reply, denied);

      const ids = lower(request.body.media_ids);
      await sql`
        delete from label_media where label_id = ${label.id} and media_id in ${sql(ids)}
      `;
      return labelCard(memory.id, caller, label.id);
    },
  );
}
