-- m-33 Montage stages (TASK-463): ролик собирается пятью новыми этапами — подготовка, анализ,
-- режиссура, музыка, сборка (doc-03); у записи журнала появляется что сказать сверх общих колонок,
-- у ролика — что насчитал заказ. Контракт — docs/journal.md и docs/montages.md.
-- Idempotent (see README «Миграции»): the version mark is written as a separate
-- query, and a process killed between the two replays this file.
--
-- The number leaves a gap, as 010 through 170 did: milestones are written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied.

-- Коды этапов. Отсева внутри сборки больше нет: первым этапом стала подготовка, разбор кадров —
-- анализом, ритм — музыкой. Старые ролики переводятся на новые коды на месте, чтобы журнал
-- собранного раньше ролика читал тот же экран. Ключ (montage_id, stage) переименование не ломает:
-- старые и новые коды не пересекаются.
ALTER TABLE montage_journal_entries DROP CONSTRAINT IF EXISTS montage_journal_entries_stage_check;
ALTER TABLE montage_stages DROP CONSTRAINT IF EXISTS montage_stages_stage_check;

UPDATE montage_journal_entries
   SET stage = CASE stage WHEN 'screening' THEN 'prep'
                          WHEN 'understanding' THEN 'analysis'
                          WHEN 'rhythm' THEN 'music' END
 WHERE stage IN ('screening', 'understanding', 'rhythm');
UPDATE montage_stages
   SET stage = CASE stage WHEN 'screening' THEN 'prep'
                          WHEN 'understanding' THEN 'analysis'
                          WHEN 'rhythm' THEN 'music' END
 WHERE stage IN ('screening', 'understanding', 'rhythm');

ALTER TABLE montage_journal_entries ADD CONSTRAINT montage_journal_entries_stage_check
  CHECK (stage IN ('prep', 'analysis', 'directing', 'music', 'assembly'));
ALTER TABLE montage_stages ADD CONSTRAINT montage_stages_stage_check
  CHECK (stage IN ('prep', 'analysis', 'directing', 'music', 'assembly'));

-- Что запись говорит сверх общих колонок: у анализа — описание кадра полями, у музыки — сколько в
-- части истории музыки и живого звука. Свободный jsonb по той же причине, что `outcome` у этапа:
-- у каждого этапа своё, а фразу строит приложение. Потолок держит запись порцией опроса, а не
-- документом: поля по отдельности обрезает воркер (docs/journal.md), база — общий размер.
ALTER TABLE montage_journal_entries ADD COLUMN IF NOT EXISTS details jsonb
  CONSTRAINT montage_journal_entries_details_check
  CHECK (jsonb_typeof(details) = 'object' AND char_length(details::text) <= 4000);

-- Сколько фото и видео насчитал заказ — те же числа, что показал «итог перед монтажом». Пишет API
-- при заказе; ими ролик в очереди говорит «что заказано» и по ним прикидывает, сколько ждать.
-- Пусто — ролик заказан раньше этих колонок.
ALTER TABLE montages ADD COLUMN IF NOT EXISTS photos integer;
ALTER TABLE montages ADD COLUMN IF NOT EXISTS videos integer;
