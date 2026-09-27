-- TASK-422: кадр, который тот, кто его принёс, скрыл из общей ленты и из монтажа, и место съёмки,
-- поправленное им руками.
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap, as 010 through 140 did: milestones are written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied. 160 — за
-- соседней задачей о роликах (TASK-423).

-- Скрыт ли кадр. Скрытый не приходит никому, кроме того, кто его принёс, и не идёт в ролик —
-- ни в предел длины у api, ни в сборку у воркера, даже названный организатором «включить»
-- (TASK-424). Это не удаление: байты, счётчики и лейблы остаются, и снять флаг можно в любой
-- момент. NOT NULL с `false`: всё загруженное до этого файла видно, как и было, и третьего
-- «не задано» читателю разбирать не нужно.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

-- Когда тот, кто принёс кадр, в последний раз сам поставил ему место; null — место камеры.
--
-- Место (`latitude`, `longitude`) пишет воркер, когда читает оригинал (`media_frame_info`), и
-- читает он его не один раз: ретраи, догоняющий обход по кадрам без размера — раз в сутки, пока
-- размер не найдётся, — и первый разбор, который вполне может прийти *после* правки, если человек
-- поправил место сразу после отправки. Каждый раз воркер пишет обе колонки целиком. Поэтому
-- «поправлено человеком» держит база, а не договорённость: триггер ниже оставляет место, пока
-- правка человека в силе, какой бы запрос ни пришёл его перезаписать. «Ещё не разобрано» и
-- «разобрано» здесь различать незачем — слово человека сильнее камеры в любом порядке.
--
-- Время, а не boolean, потому что по нему триггер отличает новую правку от чужой записи: api
-- ставит сюда `clock_timestamp()` при каждой правке места, и только запрос, который это поле
-- сдвинул, может место поменять. Дата съёмки отметки не требует: `captured_at` пишет приложение
-- при заявке, а воркер его только читает.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS place_edited_at timestamptz;

CREATE OR REPLACE FUNCTION media_items_keep_hand_placed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.latitude := OLD.latitude;
  NEW.longitude := OLD.longitude;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS media_items_keep_hand_placed ON media_items;
CREATE TRIGGER media_items_keep_hand_placed
  BEFORE UPDATE OF latitude, longitude ON media_items
  FOR EACH ROW
  WHEN (OLD.place_edited_at IS NOT NULL
        AND NEW.place_edited_at IS NOT DISTINCT FROM OLD.place_edited_at)
  EXECUTE FUNCTION media_items_keep_hand_placed();
