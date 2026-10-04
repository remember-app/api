-- Откат уносит записанные ISO, экспозиции и выдержки: код, который работает после
-- отката, их не знает. Сами кадры остаются.
ALTER TABLE media_items DROP COLUMN IF EXISTS shutter;
ALTER TABLE media_items DROP COLUMN IF EXISTS exposure_ev;
ALTER TABLE media_items DROP COLUMN IF EXISTS iso;
