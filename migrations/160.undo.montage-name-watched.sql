-- Откат уносит данные имена и отметки «посмотрел»: код, который работает после
-- отката, их не знает. Сами ролики остаются.
DROP TABLE IF EXISTS montage_watches;
ALTER TABLE montages DROP COLUMN IF EXISTS name;
