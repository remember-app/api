-- m-3 Upload: the media of a memory, and the per-user tally future pricing will
-- read. Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The `jobs` queue is deliberately absent: it belongs to montage
-- (`schema.sql`, `python worker.py init`) and api only inserts into it.

CREATE TABLE IF NOT EXISTS media_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id     uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  -- Who brought it. Cascades, unlike memories.organizer_id: one person's
  -- uploads leaving with them is exactly the rule for exclusion and departure
  -- (architecture.md, «Выход / исключение участника»), and nobody else's
  -- material rides along.
  uploaded_by   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('photo', 'video')),
  -- pending_upload -> processing -> ready | failed. The worker owns everything
  -- past `processing`.
  status        text NOT NULL DEFAULT 'pending_upload'
                CHECK (status IN ('pending_upload', 'processing', 'ready', 'failed')),
  -- The key of the original in R2, written once at intent rather than derived
  -- at read time: the naming may change, and rows already written must keep
  -- pointing at the bytes they were given.
  original_key  text NOT NULL,
  -- The R2 multipart upload this row waits on. Kept because a re-issued link
  -- must resume *this* upload — starting a new one would throw away the parts
  -- already sent — and because aborting a leftover needs its id.
  upload_id     text,
  -- Declared by the client at intent, overwritten with the size R2 actually
  -- holds when the upload completes. The counters move by the measured one.
  size_bytes    bigint NOT NULL,
  -- When it was shot, off the phone's gallery. Null is a real case: a file may
  -- carry no date at all, and the montage then orders it by arrival.
  captured_at   timestamptz,
  -- Filled by the montage worker when it probes the original; the derivative
  -- keys with it (architecture.md, «Хранилище и медиа-пайплайн»).
  width         integer,
  height        integer,
  duration_seconds double precision,
  thumbnail_key text,
  preview_key   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The gallery of one memory, which is the only way this table is read in bulk.
CREATE INDEX IF NOT EXISTS media_items_memory_idx ON media_items (memory_id, created_at);
-- The hourly sweep for uploads that never finished (architecture.md,
-- «Обработка ошибок»): partial, because it is a rounding error of the table.
CREATE INDEX IF NOT EXISTS media_items_pending_idx
  ON media_items (created_at) WHERE status = 'pending_upload';

-- One row per person, moved inside the same transaction as the media row it
-- counts. Under future pricing this is what a plan is checked against; a
-- per-month ledger of events is post-MVP (architecture.md, «Модель данных»).
CREATE TABLE IF NOT EXISTS user_usage (
  user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  storage_bytes bigint  NOT NULL DEFAULT 0,
  upload_count  integer NOT NULL DEFAULT 0,
  montage_count integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
