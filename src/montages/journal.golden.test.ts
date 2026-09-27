import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { buildTestApp, cleanupTestUsers, signIn, testEmail } from "../auth/testing.ts";
import { sql } from "../db.ts";

/**
 * Журнал, который написал не человек: `golden/journal_*.json` — записанный вывод
 * настоящей сборки воркера (копия из projects/montage/tests/fixtures, см. docs/testing.md, «Журнал
 * монтажа — снимки и записанные ответы»). Тест загружает его в базу как ролик
 * настоящего воспоминания и читает только настоящими маршрутами; ответы, которые
 * читает приложение, сверяет с `golden/responses_*.json` (или перезаписывает, если
 * позвать с JOURNAL_RECORD_RESPONSES=1).
 *
 * Живой сеанс ведёт базу так же, как воркер (`../montage/journal.py`): `begin` заводит все
 * пять этапов разом, в ожидании и с оценкой времени, до первой записи; дальше этапы только
 * меняются (`start`, `progress`, `finish`) и дописываются записи. Этап, которого нет в базе,
 * тест не «создаёт» — он такой шаг сделать не может (см. `worker` ниже).
 *
 * Хранилища нет, как и в journal.test.ts: ссылки подписываются локально.
 * MONTAGE_VIEWER_WINDOW_SECONDS раздут, чтобы «кто смотрит» не зависело от того,
 * насколько загружена машина: записанные ответы обязаны быть одними и теми же.
 */
process.env.R2_ENDPOINT = "http://recorded.test:9000";
process.env.R2_BUCKET = "recorded";
process.env.R2_ACCESS_KEY_ID = "recorded";
process.env.R2_SECRET_ACCESS_KEY = "recorded-secret";
process.env.MONTAGE_VIEWER_WINDOW_SECONDS = "86400";
process.env.R2_DOWNLOAD_TTL_SECONDS = "900";

const tag = "m27journal";
const mine = `${tag}-test %`;

const sweep = async () => {
  await sql`
    delete from jobs where ref in (
      select id::text from montages where memory_id in (
        select id from memories where title like ${mine}
      )
    )
  `;
  await sql`delete from memories where title like ${mine}`;
  await cleanupTestUsers(tag);
};
// Каждый тест убирает за собой сам: имена в записанных ответах одни и те же, а
// ник в базе один на всех. Прогон, оборвавшийся посередине, чистится в начале.
beforeAll(sweep);
afterEach(sweep);
afterAll(() => sql.end());

// ---------------------------------------------------------------- снимок

type SnapEntry = {
  n: number;
  stage: string;
  media: string | null;
  thought: string | null;
  decision: string | null;
  reason: string | null;
  series_size: number | null;
  story_part: number | null;
  story_part_title: string | null;
  source_from_seconds: number | null;
  source_to_seconds: number | null;
  labels: string[] | null;
  focus: { x: number; y: number; w: number; h: number } | null;
  created_at: string;
};
type SnapStage = {
  stage: string;
  state: string;
  started_at: string | null;
  finished_at: string | null;
  eta_seconds: number | null;
  done_count: number;
  total_count: number | null;
  outcome: Record<string, unknown>;
  updated_at: string;
};
type Snapshot = {
  format: number;
  scenario: string;
  montage: { status: string; duration_seconds: number; params: Record<string, unknown> };
  files: {
    label: string;
    kind: "photo" | "video";
    position: number;
    captured_after_seconds: number;
    duration_seconds: number | null;
  }[];
  stages: SnapStage[];
  entries: SnapEntry[];
  layout: { media: string; start_seconds: number; duration_seconds: number }[];
};

const golden = (file: string) => fileURLToPath(new URL(`./golden/${file}`, import.meta.url));
const snapshots = ["director", "algorithm"].map((scenario) => {
  const snap = JSON.parse(readFileSync(golden(`journal_${scenario}.json`), "utf8")) as Snapshot;
  // Формат поменяли — читать его по-старому значит тихо загрузить не то.
  if (snap.format !== 1)
    throw new Error(`journal_${scenario}.json: format ${snap.format}, ждали 1`);
  return snap;
});

// Метки времени снимка — настоящие моменты (секунды от 2026-01-01Z, порядок
// сохранён): в базу они ложатся как есть, потому и ответы стабильны.
const at = (stamp: string | null) => (stamp === null ? null : new Date(stamp));
const iso = (stamp: string | null) => (stamp === null ? null : new Date(stamp).toISOString());
// Съёмка файлов — от произвольной, но одной и той же отправной точки.
const shotBase = Date.UTC(2025, 11, 31, 18);
const shotAt = (seconds: number) => new Date(shotBase + seconds * 1000).toISOString();

/**
 * Копия ручки оценки воркера `journal.ESTIMATE`: секунд на файл материала и на секунду
 * заказанного ролика. Снимок оценку начала сборки не хранит (закрытый этап стоит с нулём),
 * а `begin` пишет её первой, — поэтому она здесь копией, как и сами снимки (docs/testing.md, «Снимки —
 * копии»): воркер подстроил числа — обновить их тут и перезаписать ответы.
 */
const ESTIMATE: Record<string, [number, number]> = {
  screening: [1.5, 0],
  understanding: [0.8, 0],
  directing: [0.5, 0],
  rhythm: [0.2, 0.1],
  assembly: [0, 1.4],
};
/** Округление Python (`round`): половина — к чётному; `Math.round` дало бы на «6,5» семь вместо шести. */
const roundLikePython = (x: number) => {
  const floor = Math.floor(x);
  const rest = x - floor;
  return rest < 0.5 || (rest === 0.5 && floor % 2 === 0) ? floor : floor + 1;
};
/** Оценка этапа, которую `journal.begin` ставит в самом начале сборки. */
const beginEstimate = (snap: Snapshot, stage: string) => {
  const [perFile, perSecond] = ESTIMATE[stage] ?? [0, 0];
  return roundLikePython(
    perFile * snap.files.length + perSecond * Number(snap.montage.params.target_seconds),
  );
};

// ---------------------------------------------------------------- ответы api

type ApiEntry = Omit<SnapEntry, "n" | "media"> & { id: number; media_id: string | null };
type ApiStage = SnapStage & { taken_count: number; skipped_count: number; thought_count: number };
type ApiFile = {
  id: string;
  kind: string;
  uploaded_by: string;
  captured_at: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  places: { start_seconds: number; duration_seconds: number }[];
};
type Journal = {
  montage: { id: string; status: string };
  stages: ApiStage[];
  entries: ApiEntry[];
  has_more: boolean;
  files: ApiFile[];
  viewers: { id: string; username: string | null }[];
};
type ListItem = { id: string; status: string; stages: { stage: string; state: string }[] | null };

/** Что api сказало про запись, в тех же словах, что и снимок: файл — меткой, время — моментом. */
const saidByApi = (e: ApiEntry, label: (id: string) => string) => {
  const { id, media_id, created_at, ...rest } = e;
  return {
    ...rest,
    media: media_id === null ? null : label(media_id),
    created_at: iso(created_at),
  };
};
const saidBySnapshot = (e: SnapEntry) => {
  const { n, created_at, ...rest } = e;
  return { ...rest, created_at: iso(created_at) };
};

// ---------------------------------------------------------------- стенд

type App = ReturnType<typeof buildTestApp>["app"];
type Who = "organizer" | "contributor" | "viewer" | "stranger";
type Step = {
  name: string;
  request: { as: Who | null; method: "GET"; path: string; query: Record<string, string | number> };
  response: { status: number; body: unknown };
};

/** Фиксированный uuid для записанных ответов: буква — про что, номер — какой по счёту. */
const fixedId = (kind: "a" | "b" | "c" | "f", n: number) =>
  `00000000-0000-4000-8000-${kind}${String(n).padStart(11, "0")}`;

const chunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/**
 * Воспоминание с тремя участниками и посторонним, файлами из снимка — и всё,
 * чем ролик читается: запись в базу «как воркер» и чтение «как приложение».
 */
async function stand(app: App, snap: Snapshot) {
  const email = () => testEmail(tag);
  const people = {
    organizer: await signIn(app, email()),
    contributor: await signIn(app, email()),
    viewer: await signIn(app, email()),
    stranger: await signIn(app, email()),
  };
  const created = await app.inject({
    method: "POST",
    url: "/memories",
    headers: { authorization: `Bearer ${people.organizer.token}` },
    payload: { title: `${tag}-test ${randomUUID()}`, event_start: "2026-01-01T00:00:00Z" },
  });
  expect(created.statusCode).toBe(201);
  const memoryId = (created.json() as { id: string }).id;
  for (const role of ["contributor", "viewer"] as const) {
    await sql`
      insert into memory_members (memory_id, user_id, role, invited_by)
      values (${memoryId}, ${people[role].user.id}, ${role}, ${people.organizer.user.id})
    `;
  }

  // Настоящие id остаются в базе; в записанные ответы уходят фиксированные.
  const fixed = new Map<string, string>([[memoryId, fixedId("a", 1)]]);
  const usernames = { organizer: "anya", contributor: "marko", viewer: "lena", stranger: "ivan" };
  for (const [i, who] of (["organizer", "contributor", "viewer", "stranger"] as const).entries()) {
    await sql`update users set username = ${usernames[who]} where id = ${people[who].user.id}`;
    fixed.set(people[who].user.id, fixedId("c", i + 1));
  }

  // Файлы — по одному на строку снимка, в порядке съёмки; привозят их организатор
  // и участник по очереди (зритель ничего не привозит).
  const media = new Map<string, string>();
  const uploader = new Map<string, string>();
  for (const [i, file] of snap.files.entries()) {
    const id = randomUUID();
    const by = i % 2 === 0 ? people.organizer.user.id : people.contributor.user.id;
    await sql`
      insert into media_items (
        id, memory_id, uploaded_by, kind, status, original_key, thumbnail_key,
        size_bytes, captured_at, duration_seconds
      )
      values (
        ${id}, ${memoryId}, ${by}, ${file.kind}, 'ready', ${`originals/${id}`},
        ${`thumbs/${id}.jpg`}, 4096, ${shotAt(file.captured_after_seconds)},
        ${file.duration_seconds}
      )
    `;
    media.set(file.label, id);
    uploader.set(file.label, by);
    fixed.set(id, fixedId("f", file.position));
  }
  const label = (id: string) => {
    const found = [...media].find(([, real]) => real === id);
    if (!found) throw new Error(`api назвало файл, которого в снимке нет: ${id}`);
    return found[0];
  };

  const mediaId = (fileLabel: string) => {
    const id = media.get(fileLabel);
    if (!id) throw new Error(`в снимке нет файла ${fileLabel}`);
    return id;
  };

  // ---- запись, как её ведёт воркер
  const entryN = new Map<number, number>(); // id записи в базе → её номер в снимке
  const montage = async (
    status: string,
    n: number,
    fields: Record<string, unknown> & { created_at: Date },
  ) => {
    const [row] = await sql<{ id: string }[]>`
      insert into montages ${sql({
        memory_id: memoryId,
        ordered_by: people.organizer.user.id,
        status,
        updated_at: fields.created_at,
        ...fields,
      })}
      returning id
    `;
    if (!row) throw new Error("no montage row");
    fixed.set(row.id, fixedId("b", n));
    return row.id;
  };
  const ordered = (params: Record<string, unknown>) =>
    sql.json(
      Object.fromEntries(
        Object.entries(params).map(([key, value]) => [
          key,
          key === "include_media_ids" || key === "exclude_media_ids"
            ? (value as string[]).map(mediaId)
            : value,
        ]),
      ) as Parameters<typeof sql.json>[0],
    );
  const putStage = (montageId: string, row: SnapStage, over: Record<string, unknown> = {}) => {
    const fields = {
      state: row.state,
      started_at: at(row.started_at),
      finished_at: at(row.finished_at),
      eta_seconds: row.eta_seconds,
      done_count: row.done_count,
      total_count: row.total_count,
      outcome: sql.json(row.outcome as Parameters<typeof sql.json>[0]),
      updated_at: at(row.updated_at),
      ...over,
    };
    return sql`
      insert into montage_stages ${sql({ montage_id: montageId, stage: row.stage, ...fields })}
      on conflict (montage_id, stage) do update set ${sql(fields)}
    `;
  };
  /**
   * Этапы, как их пишет воркер (`journal.py`). `begin` заводит все пять строк разом; `start`,
   * `progress` и `finish` только `UPDATE`-ят — строки, которой нет, они не создают, как и
   * воркер. Каждый шаг отдаёт строку такой, какой она легла в базу.
   */
  const worker = (montageId: string) => {
    type Row = Omit<SnapStage, "started_at" | "finished_at" | "updated_at"> & {
      started_at: Date | null;
      finished_at: Date | null;
      updated_at: Date;
    };
    const columns = sql`stage, state, started_at, finished_at, eta_seconds, done_count, total_count, outcome, updated_at`;
    const said = (rows: Row[], stage: string): SnapStage => {
      const [row] = rows;
      if (!row) throw new Error(`воркер меняет этап, которого нет в базе: ${stage}`);
      return {
        ...row,
        started_at: row.started_at?.toISOString() ?? null,
        finished_at: row.finished_at?.toISOString() ?? null,
        updated_at: row.updated_at.toISOString(),
      };
    };
    return {
      /** До первого файла: пять этапов в ожидании, у каждого — оценка от числа файлов и длины ролика. */
      begin: async (moment: Date) => {
        const rows: SnapStage[] = [];
        for (const { stage } of snap.stages) {
          const written = await sql<Row[]>`
            insert into montage_stages (montage_id, stage, eta_seconds, updated_at)
            values (${montageId}, ${stage}, ${beginEstimate(snap, stage)}, ${moment})
            on conflict (montage_id, stage) do update
              set state = 'pending', started_at = null, finished_at = null,
                  eta_seconds = excluded.eta_seconds, done_count = 0, total_count = null,
                  outcome = '{}', updated_at = excluded.updated_at
            returning ${columns}
          `;
          rows.push(said(written, stage));
        }
        return rows;
      },
      /** Этап пошёл: `running`, начало и сколько считать. Оценку не трогает — она с `begin`. */
      start: async (row: SnapStage) =>
        said(
          await sql<Row[]>`
            update montage_stages
               set state = 'running', started_at = ${at(row.started_at)}, finished_at = null,
                   total_count = coalesce(${row.total_count}, total_count),
                   updated_at = ${at(row.started_at)}
             where montage_id = ${montageId} and stage = ${row.stage}
            returning ${columns}
          `,
          row.stage,
        ),
      /** «N из M» и пересчёт оценки по факту: потрачено на сделанное, умноженное на оставшееся. */
      progress: async (row: SnapStage, done: number, moment: Date) =>
        said(
          await sql<Row[]>`
            update montage_stages
               set done_count = ${done}::int,
                   eta_seconds = case
                     when ${done}::int > 0 and started_at is not null and total_count >= ${done}::int
                     then greatest(round(extract(epoch from ${moment}::timestamptz - started_at)
                                         / ${done}::int * (total_count - ${done}::int)), 0)
                     else eta_seconds end,
                   updated_at = ${moment}
             where montage_id = ${montageId} and stage = ${row.stage}
            returning ${columns}
          `,
          row.stage,
        ),
      /** Этап кончился, итог — из снимка: он и есть то, что воркер записал. */
      finish: async (row: SnapStage) =>
        said(
          await sql<Row[]>`
            update montage_stages
               set state = ${row.state}, finished_at = ${at(row.finished_at)},
                   eta_seconds = ${row.eta_seconds}, done_count = ${row.done_count},
                   outcome = ${sql.json(row.outcome as Parameters<typeof sql.json>[0])},
                   updated_at = ${at(row.updated_at)}
             where montage_id = ${montageId} and stage = ${row.stage}
            returning ${columns}
          `,
          row.stage,
        ),
    };
  };
  const putEntries = async (montageId: string, entries: SnapEntry[]) => {
    for (const e of entries) {
      const [row] = await sql<{ id: string }[]>`
        insert into montage_journal_entries ${sql({
          montage_id: montageId,
          stage: e.stage,
          media_id: e.media === null ? null : mediaId(e.media),
          thought: e.thought,
          decision: e.decision,
          reason: e.reason,
          series_size: e.series_size,
          story_part: e.story_part,
          story_part_title: e.story_part_title,
          source_from_seconds: e.source_from_seconds,
          source_to_seconds: e.source_to_seconds,
          labels: e.labels,
          focus_x: e.focus?.x ?? null,
          focus_y: e.focus?.y ?? null,
          focus_w: e.focus?.w ?? null,
          focus_h: e.focus?.h ?? null,
          created_at: at(e.created_at),
        })}
        returning id
      `;
      if (!row) throw new Error("no journal row");
      entryN.set(Number(row.id), e.n);
    }
  };
  const putLayout = async (montageId: string, layout = snap.layout) => {
    for (const frame of layout) {
      await sql`
        insert into montage_frames (montage_id, media_id, start_seconds, duration_seconds)
        values (${montageId}, ${mediaId(frame.media)}, ${frame.start_seconds}, ${frame.duration_seconds})
      `;
    }
  };
  const finish = (montageId: string) =>
    sql`
      update montages set status = 'ready', duration_seconds = ${snap.montage.duration_seconds},
        video_key = ${`videos/${montageId}.mp4`}, poster_key = ${`posters/${montageId}.jpg`}
      where id = ${montageId}
    `;
  /** Ролик из снимка целиком — как он лежит после сборки. */
  const built = async (status: string, layout = snap.layout) => {
    const id = await montage(status, 1, {
      params: ordered(snap.montage.params),
      created_at: new Date("2025-12-31T12:00:00Z"),
    });
    for (const row of snap.stages) await putStage(id, row);
    await putEntries(id, snap.entries);
    await putLayout(id, layout);
    if (status === "ready") await finish(id);
    return id;
  };

  // ---- чтение, как приложение, и запись ответов для него
  const steps: Step[] = [];
  const fixText = (text: string) => {
    let out = text;
    for (const [real, fix] of fixed) out = out.replaceAll(real, fix);
    return out;
  };
  const fixBody = (body: unknown) => {
    const walk = (value: unknown, key: string): unknown => {
      if (Array.isArray(value)) {
        const items = value.map((v) => walk(v, key));
        // Порядок файлов в ответе api не обещает — в записи он по id.
        return key === "files"
          ? (items as { id: string }[]).sort((a, b) => a.id.localeCompare(b.id))
          : items;
      }
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => {
            if (typeof v === "string" && k.endsWith("_url")) return [k, signedLink(v)];
            if (k === "entries" && Array.isArray(v)) {
              return [k, v.map((e) => ({ ...(walk(e, k) as object), id: entryNumber(e.id) }))];
            }
            return [k, walk(v, k)];
          }),
        );
      }
      return value;
    };
    return walk(JSON.parse(fixText(JSON.stringify(body))), "");
  };
  // Ссылка настоящая: подписана и с сроком. В запись идёт без подписи и срока,
  // которые меняются от запроса к запросу.
  const signedLink = (link: string) => {
    const url = new URL(link);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    return `${url.origin}${url.pathname}?signed`;
  };
  const entryNumber = (id: number) => {
    const n = entryN.get(id);
    if (n === undefined) throw new Error(`api отдало запись, которую тест не писал: ${id}`);
    return n;
  };

  async function ask<T>(
    name: string | null,
    who: Who | null,
    path: string,
    query: Record<string, string | number> = {},
  ) {
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
    );
    const answer = await app.inject({
      method: "GET",
      url: qs.size > 0 ? `${path}?${qs}` : path,
      headers: who === null ? {} : { authorization: `Bearer ${people[who].token}` },
    });
    const body = answer.json() as T;
    if (name !== null) {
      steps.push({
        name,
        request: {
          as: who,
          method: "GET",
          path: fixText(path),
          // Курсор — id из базы; в запись он идёт номером записи в снимке.
          query: Object.fromEntries(
            Object.entries(query).map(([k, v]) => [
              k,
              (k === "after" || k === "before") && v !== 0
                ? entryNumber(Number(v))
                : typeof v === "string"
                  ? fixText(v)
                  : v,
            ]),
          ),
        },
        response: { status: answer.statusCode, body: fixBody(body) },
      });
    }
    return { status: answer.statusCode, body };
  }

  return {
    app,
    people,
    memoryId,
    media,
    mediaId,
    uploader,
    label,
    entryN,
    steps,
    ask,
    montage,
    ordered,
    putStage,
    worker,
    putEntries,
    putLayout,
    finish,
    built,
    journalPath: (montageId: string, memory = memoryId) =>
      `/memories/${memory}/montages/${montageId}/journal`,
    listPath: `/memories/${memoryId}/montages`,
    as: (who: Who) => ({ authorization: `Bearer ${people[who].token}` }),
  };
}
type Stand = Awaited<ReturnType<typeof stand>>;

// ---------------------------------------------------------------- ожидания

/** Что журнал обязан сказать про этапы, если записаны такие-то записи. */
const countersOf = (stage: string, written: SnapEntry[]) => {
  const mine = written.filter((e) => e.stage === stage);
  return {
    taken_count: mine.filter((e) => e.decision === "take").length,
    skipped_count: mine.filter((e) => e.decision === "skip").length,
    thought_count: mine.filter((e) => e.decision === null).length,
  };
};

/** Файлы отданной порции: сведения о них, включая места в раскладке, если она уже есть. */
const expectFiles = (s: Stand, snap: Snapshot, body: Journal, layoutWritten: boolean) => {
  const mentioned = [...new Set(body.entries.map((e) => e.media_id).filter((id) => id !== null))];
  expect(body.files.map((f) => f.id).sort()).toEqual(mentioned.sort());
  for (const file of body.files) {
    const label = s.label(file.id);
    const spec = snap.files.find((f) => f.label === label);
    expect(file).toMatchObject({
      kind: spec?.kind,
      uploaded_by: s.uploader.get(label),
      duration_seconds: spec?.duration_seconds,
      captured_at: shotAt(spec?.captured_after_seconds ?? Number.NaN),
    });
    expect(new URL(file.thumbnail_url ?? "").pathname).toContain(`thumbs/${file.id}.jpg`);
    expect(file.places).toEqual(
      layoutWritten
        ? snap.layout
            .filter((frame) => frame.media === label)
            .sort((a, b) => a.start_seconds - b.start_seconds)
            .map(({ start_seconds, duration_seconds }) => ({ start_seconds, duration_seconds }))
        : [],
    );
  }
};

// ---------------------------------------------------------------- записанные ответы

const recorded = (scenario: string) => golden(`responses_${scenario}.json`);

/** Сверка с закоммиченным — или, по явному флагу, перезапись. Молча не пишет никогда. */
const checkRecorded = (scenario: string, steps: Step[]) => {
  const doc = { format: 1, scenario, source: `journal_${scenario}.json`, steps };
  if (process.env.JOURNAL_RECORD_RESPONSES === "1") {
    writeFileSync(recorded(scenario), `${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  const committed = JSON.parse(readFileSync(recorded(scenario), "utf8")) as typeof doc;
  const hint = "записанные ответы разошлись с тем, что api отдаёт сейчас (docs/testing.md)";
  expect(committed.format, hint).toBe(1);
  expect(
    steps.map((step) => step.name),
    hint,
  ).toEqual(committed.steps.map((step) => step.name));
  for (const [i, step] of steps.entries()) {
    expect(step, `${hint}: шаг ${step.name}`).toEqual(committed.steps[i]);
  }
};

// ---------------------------------------------------------------- тесты

describe.each(snapshots)("журнал настоящей сборки воркера — $scenario", (snap) => {
  test("живьём по курсору, после «готов» — целиком и запись в запись; места кадров, права", async () => {
    const { app } = buildTestApp();
    const s = await stand(app, snap);
    const { ask, people } = s;
    const day = (iso: string) => ({ created_at: new Date(iso) });

    // Ролик без журнала: старый, собранный до журнала, и ждущий в очереди.
    const old = await s.montage("ready", 2, {
      ...day("2025-12-30T12:00:00Z"),
      params: sql.json({ target_seconds: 30 }),
      video_key: "videos/old.mp4",
      poster_key: "posters/old.jpg",
      duration_seconds: 30,
    });
    const queued = await s.montage("queued", 3, day("2026-01-01T12:00:00Z"));
    const bare = (status: string, id: string) => ({
      montage: { id, status },
      stages: [],
      entries: [],
      has_more: false,
      files: [],
    });
    for (const [name, id, status] of [
      ["journal_of_old_ready_montage", old, "ready"],
      ["journal_of_queued_montage", queued, "queued"],
    ] as const) {
      const { status: code, body } = await ask<Journal>(name, "organizer", s.journalPath(id));
      expect(code).toBe(200);
      expect(body).toMatchObject(bare(status, id));
    }

    // Ролик из этого заказа: воркер его берёт и собирает.
    const id = await s.montage("processing", 1, {
      params: s.ordered(snap.montage.params),
      ...day("2025-12-31T12:00:00Z"),
    });
    const path = s.journalPath(id);

    const written: SnapEntry[] = [];
    const seen: ApiEntry[] = [];
    let cursor = 0;
    let layoutWritten = false;
    let poll = 0;
    // Строки этапов такими, какими воркер их оставил на этот миг (`worker` отдаёт их из базы).
    const w = s.worker(id);
    const model = new Map<string, SnapStage>();
    const track = (rows: SnapStage | SnapStage[]) => {
      for (const row of [rows].flat()) model.set(row.stage, row);
    };

    /** Опрос «что легло после курсора» — и вперёд, пока сказано, что есть ещё. */
    const catchUp = async () => {
      for (;;) {
        const { status, body } = await ask<Journal>(`live_poll_${++poll}`, "organizer", path, {
          after: cursor,
          limit: 4,
        });
        expect(status).toBe(200);
        const fresh = [...body.entries].reverse();
        // Порция примыкает к курсору: ничего не пропущено и не повторено.
        expect(fresh.every((e, i) => e.id > (fresh[i - 1]?.id ?? cursor))).toBe(true);
        seen.push(...fresh);
        cursor = Math.max(cursor, ...fresh.map((e) => e.id));
        expect(body.has_more).toBe(seen.length < written.length);

        expect(body.montage).toEqual({ id, status: "processing" });
        // Этапы есть всегда и все пять, в порядке пайплайна: строка каждого — такая, какой её
        // оставил воркер, со счётчиками по записям, что легли на этот миг.
        expect(body.stages).toEqual(
          snap.stages.map(({ stage }) => ({
            ...model.get(stage),
            ...countersOf(stage, written),
          })),
        );
        expect(body.viewers.map((v) => v.id)).toContain(people.organizer.user.id);
        expectFiles(s, snap, body, layoutWritten);
        if (!body.has_more) break;
      }
      // Всё, что записано, прочитано — и в том порядке, в каком записано.
      expect(seen.map((e) => saidByApi(e, s.label))).toEqual(written.map(saidBySnapshot));
    };

    // Воркер взял ролик и в самом начале, до первого скачанного файла, завёл все пять этапов
    // в ожидании; время — та же секунда, с какой начинается первый этап.
    const [firstStage] = snap.stages;
    if (!firstStage) throw new Error("в снимке нет этапов");
    track(await w.begin(at(firstStage.started_at) as Date));

    // Экран открыли раньше первой записи: записей нет, курсор — ноль, а этапы уже стоят —
    // все пять в ожидании, с оценкой времени, которую поставил `begin`.
    const first = await ask<Journal>("live_first_open_empty", "organizer", path, { limit: 4 });
    expect(first.body).toMatchObject({
      montage: { id, status: "processing" },
      entries: [],
      has_more: false,
      files: [],
      viewers: [{ id: people.organizer.user.id }],
    });
    expect(first.body.stages).toEqual(
      snap.stages.map(({ stage }) => ({
        stage,
        state: "pending",
        started_at: null,
        finished_at: null,
        eta_seconds: beginEstimate(snap, stage),
        done_count: 0,
        total_count: null,
        outcome: {},
        updated_at: iso(firstStage.started_at),
        taken_count: 0,
        skipped_count: 0,
        thought_count: 0,
      })),
    );

    for (const row of snap.stages) {
      const mine = snap.entries.filter((e) => e.stage === row.stage);
      if (row.stage === "assembly") {
        // Раскладку воркер пишет между ритмом и склейкой; журнал строит места по ней.
        await s.putLayout(id);
        layoutWritten = true;
      }
      track(await w.start(row));
      // У этапа без записей глазу нечем двигаться, кроме самой строки: опрос — сразу за началом.
      if (mine.length === 0) await catchUp();
      for (const [i, chunk] of chunks(mine, 5).entries()) {
        await s.putEntries(id, chunk);
        written.push(...chunk);
        const last = chunk.at(-1);
        if (row.stage === "screening" && last?.media) {
          // Отсев двигает счётчик по файлу — и после каждой записи о нём: файлов раньше нашего
          // по порядку съёмки уже просмотрено столько, какой он по счёту.
          const position = snap.files.find((f) => f.label === last.media)?.position ?? 0;
          track(await w.progress(row, position, new Date(last.created_at)));
        }
        await catchUp();

        if (row.stage === "understanding" && i === 0) {
          // Карточка на ленте: этап виден, не открывая журнала.
          const list = await ask<(ListItem & { params: unknown })[]>(
            "montage_list_while_building",
            "organizer",
            s.listPath,
          );
          expect(list.body.map((m) => [m.id, m.status])).toEqual([
            [queued, "queued"],
            [id, "processing"],
            [old, "ready"],
          ]);
          expect(list.body.map((m) => m.stages?.length ?? null)).toEqual([null, 5, null]);
          expect(list.body[1]?.stages?.map((st) => st.state)).toEqual([
            "done",
            "running",
            "pending",
            "pending",
            "pending",
          ]);
        }
        if (row.stage === "directing" && i === 0) {
          // Зритель открыл сборку посередине: свежие сверху, и рядом видно организатора.
          const late = await ask<Journal>("live_viewer_opens_mid_build", "viewer", path, {
            limit: 4,
          });
          expect(late.status).toBe(200);
          expect(late.body.entries.map((e) => e.id)).toEqual(
            seen
              .slice(-4)
              .reverse()
              .map((e) => e.id),
          );
          expect(late.body.has_more).toBe(true);
          expect(late.body.viewers.map((v) => v.id)).toEqual([
            people.viewer.user.id,
            people.organizer.user.id,
          ]);
        }
      }
      if (row.stage === "assembly") {
        // Склейка двигает счётчик по готовому куску; на середине пути — опрос.
        const half = Math.floor((row.total_count ?? 0) / 2);
        const span = Date.parse(row.finished_at ?? "") - Date.parse(row.started_at ?? "");
        const moment = Date.parse(row.started_at ?? "") + (span * half) / (row.total_count || 1);
        track(await w.progress(row, half, new Date(moment)));
        await catchUp();
      }
      track(await w.finish(row));
      await catchUp();
    }

    // Ролик собран, и те, кто стоял у экрана на последних секундах, выпадают из окна.
    await s.finish(id);
    await sql`update montage_viewers set last_seen_at = now() - interval '2 days' where montage_id = ${id}`;
    const idle = await ask<Journal>("journal_after_ready_nothing_new", "organizer", path, {
      after: cursor,
      limit: 4,
    });
    expect(idle.body).toMatchObject({ entries: [], has_more: false, viewers: [] });

    const full = await ask<Journal>("journal_of_ready_montage", "organizer", path);
    expect(full.status).toBe(200);
    // Запись в запись: по смыслу полей, от свежих к старым, ни лишней, ни потерянной.
    expect(full.body.entries.map((e) => saidByApi(e, s.label))).toEqual(
      snap.entries.map(saidBySnapshot).reverse(),
    );
    expect(full.body.has_more).toBe(false);
    expect(full.body.montage).toEqual({ id, status: "ready" });
    expect(full.body.viewers).toEqual([]);
    expect(full.body.stages).toEqual(
      snap.stages.map((row) => ({
        ...row,
        started_at: iso(row.started_at),
        finished_at: iso(row.finished_at),
        updated_at: iso(row.updated_at),
        ...countersOf(row.stage, snap.entries),
      })),
    );
    // Места кадров — раскладка снимка; файл вне раскладки — пусто.
    expectFiles(s, snap, full.body, true);
    expect(full.body.files).toHaveLength(snap.files.length);
    const placed = new Set(snap.layout.map((frame) => frame.media));
    expect(
      full.body.files
        .filter((f) => f.places.length === 0)
        .map((f) => s.label(f.id))
        .sort(),
    ).toEqual(
      snap.files
        .map((f) => f.label)
        .filter((l) => !placed.has(l))
        .sort(),
    );

    // Разговор про один кадр — лист «что с этим файлом».
    const some = snap.layout[0]?.media ?? "";
    const one = await ask<Journal>("journal_of_one_file", "organizer", path, {
      media_id: s.mediaId(some),
    });
    expect(one.body.entries.map((e) => saidByApi(e, s.label))).toEqual(
      snap.entries
        .filter((e) => e.media === some)
        .map(saidBySnapshot)
        .reverse(),
    );
    expectFiles(s, snap, one.body, true);

    const finished = await ask<ListItem[]>("montage_list_after_ready", "organizer", s.listPath);
    expect(finished.body.map((m) => [m.id, m.status, m.stages])).toEqual([
      [queued, "queued", null],
      [id, "ready", null],
      [old, "ready", null],
    ]);

    // Права: участник и зритель читают то же самое; остальным — «нет такого».
    for (const who of ["contributor", "viewer"] as const) {
      const theirs = await ask<Journal>(null, who, path);
      expect(theirs.status).toBe(200);
      expect(theirs.body.entries).toEqual(full.body.entries);
    }
    const stranger = await ask<{ error: string }>("journal_of_stranger", "stranger", path);
    expect(stranger.status).toBe(404);
    expect(stranger.body).toEqual({ error: "not found" });
    const elsewhere = await app.inject({
      method: "POST",
      url: "/memories",
      headers: s.as("organizer"),
      payload: { title: `${tag}-test ${randomUUID()}`, event_start: "2026-01-01T00:00:00Z" },
    });
    const foreign = await sql<{ id: string }[]>`
      insert into montages (memory_id, ordered_by, status)
      values (${(elsewhere.json() as { id: string }).id}, ${people.organizer.user.id}, 'ready')
      returning id
    `;
    // Чужой ролик по своему воспоминанию и свой ролик по чужому — одно и то же.
    expect((await ask(null, "organizer", s.journalPath(foreign[0]?.id ?? ""))).status).toBe(404);
    expect(
      (await ask(null, "organizer", s.journalPath(id, (elsewhere.json() as { id: string }).id)))
        .status,
    ).toBe(404);
    expect((await ask(null, null, path)).status).toBe(401);

    checkRecorded(snap.scenario, s.steps);
    await app.close();
  });

  test("упавший ролик повторяет организатор, и журнал начинается с чистого листа", async () => {
    const { app } = buildTestApp();
    const s = await stand(app, snap);
    const id = await s.built("processing");
    // Собрался до склейки и упал на ней.
    const last = snap.stages.at(-1);
    if (!last) throw new Error("в снимке нет этапов");
    await s.putStage(id, last, { state: "failed", eta_seconds: null });
    await sql`update montages set status = 'failed', error_text = 'ffmpeg упал на склейке' where id = ${id}`;
    const retry = (who: "organizer" | "contributor") =>
      app.inject({
        method: "POST",
        url: `/memories/${s.memoryId}/montages/${id}/retry`,
        headers: s.as(who),
      });

    const before = (await s.ask<Journal>(null, "organizer", s.journalPath(id))).body;
    expect(before.entries).toHaveLength(snap.entries.length);
    expect(before.stages.map((st) => st.state)).toEqual([
      ...snap.stages.slice(0, -1).map((st) => st.state),
      "failed",
    ]);
    const listed = (await s.ask<ListItem[]>(null, "organizer", s.listPath)).body;
    expect(listed[0]?.stages?.at(-1)).toEqual({ stage: last.stage, state: "failed" });

    // Не организатор — отказ, и журнал цел.
    expect((await retry("contributor")).statusCode).toBe(403);
    expect((await s.ask<Journal>(null, "organizer", s.journalPath(id))).body.entries).toHaveLength(
      snap.entries.length,
    );

    const again = await retry("organizer");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id, status: "queued", error_text: null });
    const after = (await s.ask<Journal>(null, "organizer", s.journalPath(id))).body;
    expect(after).toMatchObject({ entries: [], stages: [], files: [], has_more: false });
    expect(after.montage.status).toBe("queued");
    expect((await s.ask<ListItem[]>(null, "organizer", s.listPath)).body[0]?.stages).toBeNull();
    const [queue] = await sql<{ count: number }[]>`
      select count(*)::int from jobs where type = 'montage' and ref = ${id}
    `;
    expect(queue?.count).toBe(1);

    await app.close();
  });

  test("удалён кадр — записи о нём остались, места ушли; удалён ролик — ушёл журнал", async () => {
    const { app } = buildTestApp();
    const s = await stand(app, snap);
    const id = await s.built("ready");
    const path = s.journalPath(id);
    // Кадр из раскладки; снимает его тот, кто его привёз, — организатор (первый в съёмке).
    const gone = snap.layout[0]?.media ?? "";
    const goneId = s.mediaId(gone);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/memories/${s.memoryId}/media/${goneId}`,
      headers: s.as("organizer"),
    });
    expect(deleted.statusCode).toBe(200);

    const after = (await s.ask<Journal>(null, "organizer", path)).body;
    // Записей ровно столько же, и о кадре они всё ещё говорят.
    expect(after.entries.map((e) => saidByApi(e, s.label)).reverse()).toEqual(
      snap.entries.map(saidBySnapshot),
    );
    expect(after.entries.some((e) => e.media_id === goneId)).toBe(true);
    // Сведений о файле нет, а у остальных места прежние.
    expect(after.files.map((f) => s.label(f.id)).sort()).toEqual(
      snap.files
        .map((f) => f.label)
        .filter((l) => l !== gone)
        .sort(),
    );
    for (const file of after.files) {
      const label = s.label(file.id);
      expect(file.places).toEqual(
        snap.layout
          .filter((frame) => frame.media === label)
          .map(({ start_seconds, duration_seconds }) => ({ start_seconds, duration_seconds })),
      );
    }

    await sql`delete from montages where id = ${id}`;
    expect((await s.ask(null, "organizer", path)).status).toBe(404);
    const [left] = await sql<{ count: number }[]>`
      select (
        (select count(*) from montage_journal_entries where montage_id = ${id})
        + (select count(*) from montage_stages where montage_id = ${id})
      )::int as count
    `;
    expect(left?.count).toBe(0);

    await app.close();
  });
});

test("клип несколькими отрезками: i-я запись «беру» файла — его i-е место в `places`", async () => {
  const snap = snapshots.find((one) => one.scenario === "director");
  if (!snap) throw new Error("нет режиссёрского снимка");
  const { app } = buildTestApp();
  const s = await stand(app, snap);
  // Раскладка ложится в базу задом наперёд: порядок мест обязан идти от ролика, а не от того,
  // как строки легли в таблицу.
  const id = await s.built("ready", [...snap.layout].reverse());
  const { body } = await s.ask<Journal>(null, "organizer", s.journalPath(id));

  // Опора сверки — сам снимок: воркер ведёт «беру» и раскладку по одному списку взятых кусков,
  // так что k-я «беру» ролика стоит на k-м месте раскладки.
  const takes = [...body.entries].reverse().filter((e) => e.decision === "take");
  expect(takes.map((e) => s.label(e.media_id ?? ""))).toEqual(snap.layout.map((f) => f.media));

  const clip = body.files.find((f) => f.places.length > 1);
  if (!clip) throw new Error("в снимке нет файла с несколькими местами — сверять нечего");
  // Как сопоставляет приложение: i-я «беру» файла — i-е его место в ответе.
  expect(clip.places).toEqual(
    takes
      .filter((e) => e.media_id === clip.id)
      .map((e) => {
        const slot = snap.layout[takes.indexOf(e)];
        return { start_seconds: slot?.start_seconds, duration_seconds: slot?.duration_seconds };
      }),
  );

  await app.close();
});
