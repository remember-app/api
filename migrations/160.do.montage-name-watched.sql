-- TASK-423: имя ролика и кто его уже посмотрел (doc-03, макет SheetFilmInfo).
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap, as 010 through 140 did: milestones are written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied.

-- Имя, которое ролику дали — шаблоном при заказе или «Переименовать» потом.
-- Пусто — не назвали: наружу тогда уходит «Ролик на 1:00» по заказанной длине,
-- на языке того, кто смотрит (`view.ts`). Это подпись, а не имя, поэтому в
-- строку она не пишется и старые ролики переписывать не нужно.
ALTER TABLE montages ADD COLUMN IF NOT EXISTS name text;

-- Кто из участников открывал готовый ролик — факт «смотрел хоть раз», не
-- история показов: строка на человека, второй показ её не трогает. Пишет api,
-- по стуку приложения с экрана ролика.
CREATE TABLE IF NOT EXISTS montage_watches (
  montage_id  uuid NOT NULL REFERENCES montages (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Первый показ: в этом порядке стоят лица в «Посмотрели».
  watched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (montage_id, user_id)
);
