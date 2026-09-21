-- Откат уносит журнал вместе с таблицами: он и живёт только здесь, а код,
-- который работает после отката, журнала не знает вовсе. Сами ролики при этом
-- остаются — журнал их не держит, это рассказ о сборке, а не сборка.
DROP TABLE IF EXISTS montage_viewers;
DROP TABLE IF EXISTS montage_stages;
DROP TABLE IF EXISTS montage_journal_entries;
