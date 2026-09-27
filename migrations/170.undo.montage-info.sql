-- Откат уносит записанные шаблоны и размеры: код, который работает после отката, их не знает.
-- Сами ролики остаются.
ALTER TABLE montages DROP COLUMN IF EXISTS size_bytes;
ALTER TABLE montages DROP COLUMN IF EXISTS template;
