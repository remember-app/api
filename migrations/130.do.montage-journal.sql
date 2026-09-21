-- m-27 Montage live: журнал монтажа, который пишет воркер и читает приложение
-- (doc-03: «Монтаж в прямом эфире» и «Журнал хранится вместе с роликом»).
-- Idempotent (see README «Миграции»): the version mark is written as a separate
-- query, and a process killed between the two replays this file.
--
-- The number leaves a gap, as 010 through 090 did: milestones are written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied.
--
-- Как montages и media_items: схема — api, записи — воркера. api пишет здесь
-- ровно одну строку, `montage_viewers`, и то по факту чтения; всё остальное
-- кладёт montage. Контракт колонок — в README api, раздел «Журнал монтажа».

-- Что режиссёр сказал вслух, по записи на реплику. Только дописывается, и
-- `id` — курсор: приложение опрашивает маршрут раз в секунду-две и просит
-- «что легло после N».
CREATE TABLE IF NOT EXISTS montage_journal_entries (
  -- bigserial, а не uuid, как везде в этой базе: это и есть курсор. Порядок
  -- возрастания — единственное, что приложению нужно от идентификатора записи,
  -- и uuid его не даёт.
  id           bigserial PRIMARY KEY,
  montage_id   uuid NOT NULL REFERENCES montages (id) ON DELETE CASCADE,
  -- Пять этапов пайплайна по порядку. Коды, а не фразы: названия этапов
  -- приложение показывает на своём языке.
  stage        text NOT NULL
               CHECK (stage IN ('screening', 'understanding', 'directing', 'rhythm', 'assembly')),
  -- Кадр, про который эта запись. Пусто — мысль про план в целом.
  --
  -- Без внешнего ключа намеренно, и это единственная ссылка на media_items в
  -- базе, у которой его нет: журнал — рассказ о том, как ролик собирался, и он
  -- должен пережить и удаление кадра, и уход участника вместе со всем, что тот
  -- принёс. Строка тогда остаётся без сведений о файле, а не исчезает.
  media_id     uuid,
  -- Мысль модели, текстом. Потолок — чтобы строка оставалась компактной:
  -- приложение тянет по двести записей за опрос раз в секунду-две.
  thought      text CHECK (char_length(thought) <= 500),
  -- «беру» / «мимо»; пусто — чистая мысль без решения. Единственное поле
  -- здесь с CHECK на словарь: его рисует приложение (макет MontageLiveStage —
  -- «Беру», «Мимо»), то есть это контракт с клиентом, а не словарь воркера.
  decision     text CHECK (decision IN ('take', 'skip')),
  -- Почему мимо, кодом: blur, exposure, unreadable, duplicate, excluded,
  -- no_room, … Без CHECK — ровно по причине из 060: это словарь воркера, и
  -- новая причина не должна ждать миграции из чужого репозитория.
  reason       text CHECK (char_length(reason) <= 40),
  -- «Взял 1 из N» — сколько кадров было в серии, из которой взят этот.
  series_size  integer CHECK (series_size > 0),
  -- Куда легло: часть истории номером и её название («Часть 2 «Клятвы»»).
  story_part   integer CHECK (story_part > 0),
  story_part_title text CHECK (char_length(story_part_title) <= 80),
  -- Какой кусок исходника взят, в секундах от его начала («Беру 0:04–0:07»).
  source_from_seconds double precision CHECK (source_from_seconds >= 0),
  source_to_seconds   double precision CHECK (source_to_seconds >= 0),
  -- Метки «что увидел» (макет SheetLiveFile): «Бабушка», «смех», «тёплый
  -- свет». Потолок по числу и по суммарной длине — на элемент по отдельности
  -- его не поставить, подзапрос в CHECK Postgres не берёт, а строку в размере
  -- держит именно сумма.
  labels       text[] CHECK (
                 labels IS NULL OR (
                   cardinality(labels) <= 12
                   AND char_length(array_to_string(labels, ',')) <= 240
                 )
               ),
  -- Рамка «куда смотрит» — долями от размера кадра, не пикселями: приложение
  -- рисует её поверх миниатюры любого размера. Либо все четыре, либо ни одной;
  -- CHECK ловит ровно то, что иначе уедет за край экрана, — воркера, приславшего
  -- пиксели.
  focus_x      double precision,
  focus_y      double precision,
  focus_w      double precision,
  focus_h      double precision,
  CONSTRAINT montage_journal_entries_focus_check CHECK (
    (focus_x IS NULL AND focus_y IS NULL AND focus_w IS NULL AND focus_h IS NULL)
    OR (focus_x BETWEEN 0 AND 1 AND focus_y BETWEEN 0 AND 1
        AND focus_w > 0 AND focus_w <= 1 AND focus_h > 0 AND focus_h <= 1)
  ),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Единственный способ, которым эту таблицу читают: порция одного ролика от
-- курсора. Сужение до одного этапа идёт тем же индексом — ролик держит порядок
-- тысяч записей, а не миллионов, так что отдельного индекса под фильтр нет.
CREATE INDEX IF NOT EXISTS montage_journal_entries_cursor_idx
  ON montage_journal_entries (montage_id, id);

-- По строке на этап на ролик — пять на ролик, когда воркер до них дошёл.
-- Заводит и обновляет их он же; api только читает.
CREATE TABLE IF NOT EXISTS montage_stages (
  montage_id   uuid NOT NULL REFERENCES montages (id) ON DELETE CASCADE,
  stage        text NOT NULL
               CHECK (stage IN ('screening', 'understanding', 'directing', 'rhythm', 'assembly')),
  state        text NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending', 'running', 'done', 'failed')),
  started_at   timestamptz,
  finished_at  timestamptz,
  -- Сколько этап займёт, а для идущего — сколько ему осталось («осталось ≈ 8
  -- мин» на макете MontageLive). Пусто — оценки нет, и экран её не рисует.
  eta_seconds  integer CHECK (eta_seconds >= 0),
  -- «61 из 212 разложено». total пусто, пока не посчитано.
  done_count   integer NOT NULL DEFAULT 0 CHECK (done_count >= 0),
  total_count  integer CHECK (total_count >= 0),
  -- Итоги этапа — свободный jsonb, по ключам на этап (README). Свободный
  -- потому, что итог у каждого этапа свой («212 из 214 годятся», «37 лиц»), а
  -- фразу из него строит приложение на своём языке.
  outcome      jsonb NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Этап ролика и есть его имя: суррогатный id здесь нечему дать, а воркеру
  -- нужен ключ, по которому он кладёт строку через ON CONFLICT.
  PRIMARY KEY (montage_id, stage)
);

-- Кто смотрит сборку прямо сейчас (doc-03: «Видно, кто сейчас смотрит
-- монтаж»). Единственная таблица журнала, в которую пишет api, — самим фактом
-- чтения: отдельного «я смотрю» приложение не шлёт, опрос журнала и есть оно.
CREATE TABLE IF NOT EXISTS montage_viewers (
  montage_id   uuid NOT NULL REFERENCES montages (id) ON DELETE CASCADE,
  -- Каскадом, в отличие от montages.ordered_by: «смотрит сейчас» — это про
  -- живого человека, и держать строку ушедшего незачем.
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (montage_id, user_id)
);
