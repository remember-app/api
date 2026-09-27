-- TASK-430: сведения ролика (doc-03, макет SheetFilmInfo) — каким шаблоном его заказали и сколько
-- весит готовый файл.
-- Idempotent (see README «Миграции»): the version mark is written as a separate
-- query, and a process killed between the two replays this file.
--
-- The number leaves a gap, as 010 through 160 did: milestones are written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied.

-- С какой из шести карточек (`templates.ts`) начали заказ. Пусто — «Настроить самому»; пусто и у
-- всех роликов, заказанных раньше, — тогда это нигде не записывалось. Колонка, а не ключ в
-- `params`, по той же причине, что `name`: воркеру это не ручка — шаблон к заказу уже развёрнут в
-- историю, музыку, длину и формат, — а сведение для людей.
ALTER TABLE montages ADD COLUMN IF NOT EXISTS template text;

-- Сколько байт в готовом видео — сведение о файле того же рода, что `duration_seconds`, и место ему
-- рядом с ним. Пусто — не записан.
ALTER TABLE montages ADD COLUMN IF NOT EXISTS size_bytes bigint;
