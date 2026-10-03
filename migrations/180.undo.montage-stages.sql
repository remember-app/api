-- Откат возвращает старые коды этапов и старый CHECK, уносит поля записей и числа заказа: код,
-- который работает после отката, их не знает. Сами ролики и журналы остаются.
ALTER TABLE montages DROP COLUMN IF EXISTS videos;
ALTER TABLE montages DROP COLUMN IF EXISTS photos;
ALTER TABLE montage_journal_entries DROP COLUMN IF EXISTS details;

ALTER TABLE montage_journal_entries DROP CONSTRAINT IF EXISTS montage_journal_entries_stage_check;
ALTER TABLE montage_stages DROP CONSTRAINT IF EXISTS montage_stages_stage_check;

UPDATE montage_journal_entries
   SET stage = CASE stage WHEN 'prep' THEN 'screening'
                          WHEN 'analysis' THEN 'understanding'
                          WHEN 'music' THEN 'rhythm' END
 WHERE stage IN ('prep', 'analysis', 'music');
UPDATE montage_stages
   SET stage = CASE stage WHEN 'prep' THEN 'screening'
                          WHEN 'analysis' THEN 'understanding'
                          WHEN 'music' THEN 'rhythm' END
 WHERE stage IN ('prep', 'analysis', 'music');

ALTER TABLE montage_journal_entries ADD CONSTRAINT montage_journal_entries_stage_check
  CHECK (stage IN ('screening', 'understanding', 'directing', 'rhythm', 'assembly'));
ALTER TABLE montage_stages ADD CONSTRAINT montage_stages_stage_check
  CHECK (stage IN ('screening', 'understanding', 'directing', 'rhythm', 'assembly'));
