-- m-9 Montage: the videos ordered from a memory's material. Idempotent (see
-- README «Миграции»): the version mark is written as a separate query, and a
-- process killed between the two replays this file.
--
-- The number leaves a gap on purpose, as 010 did: m-8 is being written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied.
--
-- The `jobs` queue is absent here for the reason 004 gives: it belongs to
-- montage (`schema.sql`), and api only inserts into it — a row
-- `('montage', <montages.id>)` when a video is ordered and when a failed one is
-- retried.

CREATE TABLE IF NOT EXISTS montages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id    uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  -- The organizer who asked for it. No ON DELETE, exactly as memories.organizer_id
  -- has none: an assembled video is not taken down when somebody leaves the
  -- memory (doc-03), so it must not be taken down with a user row either.
  ordered_by   uuid NOT NULL REFERENCES users (id),
  -- queued -> processing -> ready | failed. api writes `queued` (ordering and
  -- retry); everything past it belongs to the worker.
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  -- Where the assembled video landed in R2, and how long it turned out. Both
  -- are written by the worker when it is done, so both are null until then.
  video_key    text,
  duration_seconds double precision,
  -- What was ordered: `target_seconds` and `music_track_id` (architecture.md,
  -- «Montage-пайплайн»). Free JSON rather than columns because the set of knobs
  -- is the one thing about a montage expected to move, and a knob nobody
  -- filters on does not need a column of its own.
  params       jsonb NOT NULL DEFAULT '{}',
  -- Why it failed, as the worker saw it — what the organizer's «повторить»
  -- stands next to.
  error_text   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The videos of one memory, newest first — which is the only way this table is
-- read in bulk.
CREATE INDEX IF NOT EXISTS montages_memory_idx ON montages (memory_id, created_at DESC);
