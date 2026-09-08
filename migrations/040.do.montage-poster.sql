-- m-16 Second look: the poster frame of a finished montage. A ready video had
-- a link and nothing to show before it plays, so the app had no preview for it.
-- Idempotent (see README «Миграции»): the version mark is written as a separate
-- query, and a process killed between the two replays this file.
--
-- The number leaves a gap on purpose, as 010, 020 and 030 did: milestones are
-- written in parallel against this same repository, and two migrations sharing
-- a version is a merge nobody can resolve after either has been applied.

-- Where the poster landed in R2 — beside `video_key`, written by the same hand
-- and at the same moment: the worker cuts the frame out of the video it just
-- assembled, so this is null until it is done. Nullable also because it stays
-- null forever for the videos assembled before the worker learned to cut one —
-- api has nothing to backfill it from.
ALTER TABLE montages ADD COLUMN IF NOT EXISTS poster_key text;
