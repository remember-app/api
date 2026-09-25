-- TASK-291 «Даты между днями»: настройка ленты кадров — даты стоят узкой щелью
-- между днями, а не только на полосе у края при прокрутке.
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap, as 010 through 130 did: milestones are written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied.

-- На человеке, а не на воспоминании и не на устройстве: по макету это настройка
-- аккаунта, одна на все его ленты и все его телефоны. Своя колонка, а не общий
-- JSON настроек — настройка одна, и пусть её тип держит база.
--
-- NOT NULL с `false`: у аккаунтов, заведённых до этого файла, выключено ровно
-- так же, как у новых, и третьего «не задано» приложению разбирать не нужно.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dates_between_days boolean NOT NULL DEFAULT false;
