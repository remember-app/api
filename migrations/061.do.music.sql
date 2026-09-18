-- m-23 Montage director: свой трек под ролик. Организатор заливает аудиофайл
-- тем же путём, что и материал — заявка, подписанные куски, «загружено», — а
-- заказ ролика ссылается на него ключом (doc-03, «Музыка: … и возможность
-- добавить свою»). Idempotent (see README «Миграции»): the version mark is
-- written as a separate query, and a process killed between the two replays
-- this file.
--
-- The number leaves a gap, as 010, 020, 030, 040 and 050 did: milestones are
-- written in parallel against this same repository, and two migrations sharing
-- a version is a merge nobody can resolve after either has been applied.
--
-- Своя таблица, а не третий `kind` в `media_items`: трек — не материал
-- воспоминания. В галерее ему делать нечего, в те самые «три готовых файла»,
-- без которых ролик не заказать, он не идёт, и превью с него воркер не снимает
-- — с общей таблицей каждому из этих трёх мест пришлось бы объяснять
-- исключение, и каждое из них однажды объяснение бы потеряло.

CREATE TABLE IF NOT EXISTS music_uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  -- Заливает только организатор — заказывает ролик он же. Cascades exactly as
  -- media_items.uploaded_by does: what a person brought leaves with them.
  uploaded_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- pending_upload -> ready, и третьего состояния нет: деривативов у трека не
  -- бывает, воркер его не обрабатывает — только скачивает при монтаже.
  status      text NOT NULL DEFAULT 'pending_upload'
              CHECK (status IN ('pending_upload', 'ready')),
  -- Ключ объекта в R2. Им же заказ ролика на трек и ссылается
  -- (`params.music_track_key`), поэтому он уникален: ключ — это имя трека
  -- снаружи, а два имени на один трек ничего не значат.
  object_key  text NOT NULL UNIQUE,
  -- Multipart-загрузка, которую ждёт эта строка: её надо доделать при
  -- «загружено» и оборвать, если строка уходит.
  upload_id   text,
  -- Заявленный размер, переписанный тем, что реально лежит в хранилище, —
  -- ровно как у media_items.
  size_bytes  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
