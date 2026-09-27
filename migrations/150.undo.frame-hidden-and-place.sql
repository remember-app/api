-- Откат открывает скрытые кадры всем и отдаёт место, поправленное руками, воркеру: при
-- следующем разборе он перепишет его тем, что в файле. Повторный накат начинает все кадры
-- видимыми и с местом камеры.
DROP TRIGGER IF EXISTS media_items_keep_hand_placed ON media_items;
DROP FUNCTION IF EXISTS media_items_keep_hand_placed();
ALTER TABLE media_items DROP COLUMN IF EXISTS place_edited_at;
ALTER TABLE media_items DROP COLUMN IF EXISTS hidden;
