DROP TABLE IF EXISTS label_media;
DROP TABLE IF EXISTS labels;
-- Заведён этой же миграцией поверх чужой таблицы — уходит вместе с ней.
DROP INDEX IF EXISTS media_items_id_memory_key;
