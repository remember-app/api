-- m-25 Labels: коробки с названием и цветом, по которым участник раскладывает
-- кадры воспоминания (doc-13). Лейбл либо общий — его видят все участники, —
-- либо личный, и тогда его не видит никто, кроме хозяина: ни названия, ни
-- состава. Кадр при этом никуда не копируется и из воспоминания не девается.
-- Idempotent (see README «Миграции»): отметка о версии пишется отдельным
-- запросом, и процесс, убитый между ними, проигрывает этот файл заново.
--
-- Номер оставляет разрыв, как 010, 020, 030, 040, 050 и 090: вехи пишутся
-- параллельно по одному репозиторию, а две миграции с одной версией — это
-- конфликт, который уже не разрешить после того, как применена хоть одна.

CREATE TABLE IF NOT EXISTS labels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id  uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  -- Кто завёл. Каскад тот же и по той же причине, что у media_items.uploaded_by:
  -- что человек принёс, уходит вместе с ним. Для общего лейбла это ещё и «кто
  -- может его переименовать и удалить» (TASK-189).
  owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      text NOT NULL,
  -- Номер ячейки палитры, а не краска: восемь цветов держит клиент
  -- (design/screens/SheetLabelNew.html), и светлая тема перекрашивает их у себя,
  -- ничего не спрашивая у базы. CHECK — потому что ячейки ровно восемь, и
  -- девятая означала бы кружок, который клиенту нечем нарисовать.
  color      smallint NOT NULL CHECK (color BETWEEN 1 AND 8),
  -- Общий (видят все участники воспоминания) или личный (только хозяин).
  -- Третьего состояния нет, поэтому boolean, а не text с CHECK.
  shared     boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ровно тот отбор, которым читается список: лейблы одного воспоминания, из них
-- общие и свои.
CREATE INDEX IF NOT EXISTS labels_memory_idx ON labels (memory_id, owner_id);

-- Уникальности названий здесь намеренно нет. На воспоминание она выдавала бы
-- чужие личные названия — «занято» это ответ о том, чего спрашивающий видеть не
-- должен, — а правило на каждого спрашивающего база выразить не может. Тёзки
-- разрешены: лейбл различается по id, а не по надписи.

-- Ссылочная цель для составных внешних ключей ниже: сам по себе id уже
-- уникален, но Postgres требует уникальности именно той пары, на которую
-- ссылаются.
CREATE UNIQUE INDEX IF NOT EXISTS labels_id_memory_key ON labels (id, memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_items_id_memory_key ON media_items (id, memory_id);

CREATE TABLE IF NOT EXISTS label_media (
  label_id  uuid NOT NULL,
  media_id  uuid NOT NULL,
  -- Денормализовано ради двух составных ссылок ниже: вдвоём они и есть «лейбл не
  -- выходит за своё воспоминание» — не обещание маршрута, а то, чего база просто
  -- не даст записать.
  memory_id uuid NOT NULL,
  -- Кто положил: убрать кадр из лейбла сможет он — и хозяин лейбла (TASK-189).
  -- SET NULL, а не каскад: ушёл человек — связь остаётся, и кадр, который он
  -- разложил, из чужого лейбла не выпадает.
  added_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  added_at  timestamptz NOT NULL DEFAULT now(),
  -- Один кадр лежит в нескольких лейблах сразу, но в одном и том же — один раз.
  PRIMARY KEY (label_id, media_id),
  FOREIGN KEY (label_id, memory_id) REFERENCES labels (id, memory_id) ON DELETE CASCADE,
  -- Удалённый кадр — поштучно или уходом участника — пропадает из всех лейблов
  -- сам, без единой строки в коде удаления (src/media/gallery.ts, removeMedia).
  -- Сам лейбл при этом остаётся: удаление кадра не трогает коробку.
  FOREIGN KEY (media_id, memory_id) REFERENCES media_items (id, memory_id) ON DELETE CASCADE
);

-- Обратное направление: галерея спрашивает лейблы кадра, а первичный ключ
-- отвечает только на вопрос про кадры лейбла.
CREATE INDEX IF NOT EXISTS label_media_media_idx ON label_media (media_id);
