import type { FastifyInstance } from "fastify";
import { positive } from "../auth/config.ts";
import { sql } from "../db.ts";
import { downloadTtlSeconds } from "../media/config.ts";
import { downloadUrl, storageConfigured } from "../media/r2.ts";
import { uuidPattern } from "../memories/plugin.ts";

/**
 * Как собирался ролик, вживую и потом (doc-03: «Монтаж в прямом эфире» и
 * «Журнал хранится вместе с роликом»). Экраны: design/screens/MontageLive.html,
 * MontageLiveStage.html, SheetLiveFile.html, MontageLiveDone.html.
 *
 * Тот же уговор, что у `montages.ts`: схема — api, содержание — воркера. Он
 * заводит строку этапа и дописывает записи, api их только читает. Своя строка у
 * api здесь ровно одна — `montage_viewers`, и пишется она самим фактом чтения:
 * отдельного «я смотрю» приложение не шлёт.
 *
 * Маршрут читают в цикле, раз в секунду-две, пока ролик собирается, поэтому он
 * отвечает порциями от курсора и подписывает ссылки только на те файлы, что
 * встретились в отданной порции.
 */

/**
 * Пять этапов пайплайна по порядку — тот же список, что в CHECK миграции 130,
 * и порядок здесь и есть «этап 3 из 5» на экране. Коды, а не фразы: названия
 * приложение показывает на своём языке.
 */
export const montageStages = [
  "screening",
  "understanding",
  "directing",
  "rhythm",
  "assembly",
] as const;

type StageKey = (typeof montageStages)[number];

/** Строка `montage_stages` со счётчиками, которые api досчитывает по записям. */
export type StageRow = {
  stage: StageKey;
  state: "pending" | "running" | "done" | "failed";
  started_at: Date | null;
  finished_at: Date | null;
  eta_seconds: number | null;
  done_count: number;
  total_count: number | null;
  outcome: Record<string, unknown>;
  updated_at: Date;
  taken_count: number;
  skipped_count: number;
  thought_count: number;
};

/** Строка `montage_journal_entries` ровно как её держит база. */
type EntryRow = {
  /** bigint, а postgres.js отдаёт такие строкой — см. `view` ниже. */
  id: string;
  stage: StageKey;
  media_id: string | null;
  thought: string | null;
  decision: "take" | "skip" | null;
  reason: string | null;
  series_size: number | null;
  story_part: number | null;
  story_part_title: string | null;
  source_from_seconds: number | null;
  source_to_seconds: number | null;
  labels: string[] | null;
  focus_x: number | null;
  focus_y: number | null;
  focus_w: number | null;
  focus_h: number | null;
  created_at: Date;
};

/**
 * Сколько секунд человек считается смотрящим после своего последнего запроса.
 * В окружении по той же причине, что и лимиты медиа: приложение опрашивает раз
 * в секунду-две, но интервал опроса ещё подвинется на живых телефонах, а окно
 * должно оставаться заметно шире него — иначе смотрящие будут мигать.
 */
const viewerWindowSeconds = () => positive("MONTAGE_VIEWER_WINDOW_SECONDS", 20);

/**
 * Сколько записей отдаётся за раз. Двести — это порядка десятка килобайт: у
 * мысли в базе потолок 500 символов, и порция должна уместиться в один опрос
 * раз в секунду-две.
 */
const defaultLimit = 200;
const maxLimit = 500;

/**
 * Запись наружу. Четыре доли рамки собираются в один `focus`, потому что
 * приложение рисует её целиком или не рисует вовсе — а база держит их врозь,
 * чтобы CHECK поймал воркера, приславшего пиксели вместо долей.
 *
 * `id` уходит числом: это курсор, приложение запоминает наибольший и просит
 * «что после». Строкой (как postgres.js отдаёт bigint) клиент сравнивал бы «999»
 * с «1000» лексикографически и остановился бы на тысячной записи.
 */
const view = ({ focus_x, focus_y, focus_w, focus_h, id, ...entry }: EntryRow) => ({
  ...entry,
  id: Number(id),
  focus: focus_x === null ? null : { x: focus_x, y: focus_y, w: focus_w, h: focus_h },
});

/**
 * Mounted from `buildApp` after `memoriesPlugin`, которая декорирует проверку
 * участия: читает журнал любой участник воспоминания, зритель в том числе —
 * матрица даёт ему «смотреть галерею и ролики», а ролик и есть то, что здесь
 * рассказывается.
 */
export function journalRoutes(app: FastifyInstance) {
  const notFound = { error: "not found" };

  // Только сужения и курсор: тело у чтения не бывает, а схема на query отвечает
  // всем одинаково — что участнику, что чужому, — и потому ничего о
  // воспоминании не выдаёт (в отличие от схемы на path-параметры, из-за которой
  // соседние маршруты её и не ставят).
  const query = {
    type: "object",
    additionalProperties: false,
    properties: {
      // Курсор в обе стороны от того, что у клиента уже есть: `after` — что
      // легло с прошлого опроса, `before` — что было раньше показанного.
      // Записи в ответе всегда идут от свежих к старым, одним порядком на оба
      // случая: именно так их рисует экран. Выбираются они при этом по-разному
      // — см. `forward` в обработчике.
      // Потолок — не лимит журнала, а граница числа: больше него ajv пропустит
      // то, что `::bigint` уже не примет, и курсор-мусор стал бы 500.
      after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      before: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      limit: { type: "integer", minimum: 1, maximum: maxLimit, default: defaultLimit },
      stage: { type: "string", enum: [...montageStages] },
      media_id: { type: "string", pattern: uuidPattern.source },
    },
  } as const;

  app.get<{
    Params: { memoryId: string; montageId: string };
    Querystring: {
      after?: number;
      before?: number;
      limit: number;
      stage?: StageKey;
      media_id?: string;
    };
  }>(
    "/memories/:memoryId/montages/:montageId/journal",
    { preHandler: [app.authenticate, app.requireMembership], schema: { querystring: query } },
    async (request, reply) => {
      const { memory } = request.membership;
      const { montageId } = request.params;
      // «Not a uuid» — это «нет такого ролика», домашнее правило всего, что
      // стоит за проверкой участия (README, «404 один на всех»), и не схема на
      // параметры пути ровно по причине из `montages.ts`.
      if (!uuidPattern.test(montageId)) return reply.code(404).send(notFound);

      // Ролик чужого воспоминания — «нет такого ролика», тем же ответом, что и
      // несуществующий: иначе по одному id можно перебирать чужие сборки.
      const [montage] = await sql<{ id: string; status: string }[]>`
        select id, status from montages
        where id = ${montageId} and memory_id = ${memory.id}
      `;
      if (!montage) return reply.code(404).send(notFound);

      // Пока собирается — сам запрос и есть «я смотрю»: один upsert на опрос.
      // У готового и упавшего ролика не отмечает никого — смотреть за ним уже
      // нечего, а строки тех, кто стоял на последних секундах сборки, сами
      // выпадут из окна.
      const live = montage.status === "queued" || montage.status === "processing";
      if (live) {
        await sql`
          insert into montage_viewers (montage_id, user_id)
          values (${montage.id}, ${request.user.id})
          on conflict (montage_id, user_id) do update set last_seen_at = now()
        `;
      }

      const { after, before, limit, stage, media_id } = request.query;
      // Куда идёт курсор — и это единственное, чем два направления
      // отличаются. Вперёд берётся порция, **ближайшая к курсору**, то есть
      // самые старые из новых: между двумя опросами может лечь больше записей,
      // чем лимит (этап «разбор кадров» пишет по записи на файл разом), и
      // «самые новые 200» оставили бы посередине дыру, про которую клиенту
      // нечем узнать — он двигает курсор на наибольший отданный id, и всё, что
      // ниже, уже не запросит никогда. Назад и первая загрузка идут от свежих:
      // там дыра невозможна, экран листает журнал от «сейчас».
      const forward = after !== undefined;
      const [stages, rows, viewers] = await Promise.all([
        // Пять строк на ролик, когда воркер до них дошёл. Счётчики «взял /
        // мимо / мысли» api считает сам, по записям: воркер и так пишет каждую
        // из них, а второй его счёт мог бы разойтись с первым.
        sql<StageRow[]>`
          select s.stage, s.state, s.started_at, s.finished_at, s.eta_seconds,
            s.done_count, s.total_count, s.outcome, s.updated_at,
            coalesce(c.taken_count, 0) as taken_count,
            coalesce(c.skipped_count, 0) as skipped_count,
            coalesce(c.thought_count, 0) as thought_count
          from montage_stages s
          left join (
            select stage,
              count(*) filter (where decision = 'take')::int as taken_count,
              count(*) filter (where decision = 'skip')::int as skipped_count,
              count(*) filter (where decision is null)::int as thought_count
            from montage_journal_entries
            where montage_id = ${montage.id}
            group by stage
          ) c on c.stage = s.stage
          where s.montage_id = ${montage.id}
        `,
        // Порция от курсора. Лишняя запись сверх лимита — это и есть ответ на
        // «есть ли ещё»; считать всё подходящее вторым запросом значило бы
        // платить за полный скан на каждом опросе. Колонки названы, а не `*`:
        // таблицу пишет воркер, а наружу уходит только контракт.
        sql<EntryRow[]>`
          select id, stage, media_id, thought, decision, reason, series_size, story_part,
            story_part_title, source_from_seconds, source_to_seconds, labels,
            focus_x, focus_y, focus_w, focus_h, created_at
          from montage_journal_entries
          where montage_id = ${montage.id}
            and (${after ?? null}::bigint is null or id > ${after ?? null}::bigint)
            and (${before ?? null}::bigint is null or id < ${before ?? null}::bigint)
            and (${stage ?? null}::text is null or stage = ${stage ?? null}::text)
            and (${media_id ?? null}::uuid is null or media_id = ${media_id ?? null}::uuid)
          order by id ${forward ? sql`asc` : sql`desc`}
          limit ${limit + 1}
        `,
        // Свой запрос уже записан выше, так что спрашивающий видит и себя.
        sql<{ id: string; username: string | null }[]>`
          select u.id, u.username from montage_viewers v
          join users u on u.id = v.user_id
          where v.montage_id = ${montage.id}
            and v.last_seen_at > now() - make_interval(secs => ${viewerWindowSeconds()})
          order by v.last_seen_at desc
        `,
      ]);

      // Лишняя срезается с того конца, куда идёт курсор, — то есть просто с
      // хвоста выборки в обе стороны. А наружу порция всегда уходит от свежих
      // к старым: направление — дело курсора, форма ответа от него не зависит.
      const has_more = rows.length > limit;
      const page = has_more ? rows.slice(0, limit) : rows;
      const entries = forward ? page.reverse() : page;

      // Сведения только о тех файлах, что встретились в этой порции: журнал
      // ролика — это сотни записей об одних и тех же кадрах, и подписывать
      // ссылки на весь материал воспоминания на каждом опросе не за чем.
      //
      // Кадра уже нет — запись остаётся без сведений, и это не ошибка: у неё
      // нет внешнего ключа именно ради этого.
      const mediaIds = [...new Set(entries.map((e) => e.media_id).filter((id) => id !== null))];
      type File = {
        id: string;
        kind: "photo" | "video";
        uploaded_by: string;
        captured_at: Date | null;
        duration_seconds: number | null;
        thumbnail_key: string | null;
      };
      /**
       * Место кадра в этом ролике — секунда начала и сколько он держится.
       * Журнал его не хранит: раскладка лежит в общей `montage_frames`
       * («Сведения о кадре»), и вторая её копия здесь была бы вторым ответом
       * на «на какой секунде стоит кадр». Мест у файла может быть несколько —
       * ключ той таблицы включает `start_seconds`, потому что клип, разрезанный
       * надвое, и фотография, вернувшаяся в конце, стоят в ролике дважды.
       */
      type Place = { media_id: string; start_seconds: number; duration_seconds: number };
      const [media, places]: [File[], Place[]] =
        mediaIds.length > 0
          ? await Promise.all([
              sql<File[]>`
                select id, kind, uploaded_by, captured_at, duration_seconds, thumbnail_key
                from media_items
                where memory_id = ${memory.id} and id in ${sql(mediaIds)}
              `,
              // Только по файлам отданной порции и только по этому ролику: опрос
              // идёт раз в секунду-две, и тянуть раскладку всего ролика на
              // каждом не за чем. Статус ролика не важен — раскладка появляется
              // по ходу сборки, и рассказ о ней тем и живёт.
              sql<Place[]>`
                select media_id, start_seconds, duration_seconds
                from montage_frames
                where montage_id = ${montage.id} and media_id in ${sql(mediaIds)}
                order by start_seconds
              `,
            ])
          : [[], []];

      // Бакета нет — пустая ссылка, а не 503 галереи: там ссылки и есть весь
      // ответ, здесь — одно поле рассказа, который должен читаться и без них.
      const ttl = downloadTtlSeconds();
      const configured = storageConfigured();
      const files = await Promise.all(
        media.map(async ({ thumbnail_key, ...file }) => ({
          ...file,
          thumbnail_url: configured && thumbnail_key ? await downloadUrl(thumbnail_key, ttl) : null,
          // Раскладки ещё нет или кадр в ролик не вошёл — пустой список, а не
          // ошибка: пока идёт отсев, места нет ни у одного файла.
          places: places
            .filter((place) => place.media_id === file.id)
            .map(({ start_seconds, duration_seconds }) => ({ start_seconds, duration_seconds })),
        })),
      );

      return {
        montage,
        // В порядке пайплайна, а не в том, в котором их завёл воркер: «этап 3
        // из 5» на экране — это позиция в этом списке.
        stages: stages.sort(
          (a, b) => montageStages.indexOf(a.stage) - montageStages.indexOf(b.stage),
        ),
        entries: entries.map(view),
        has_more,
        files,
        viewers,
      };
    },
  );
}
