-- m-23 Montage director: what the automatic screening makes of one piece of
-- material (doc-03, «Автоматический отсев брака как предложение»). The
-- organizer sees what the analysis threw out *before* ordering a montage and
-- may put it back, so the verdict has to stand on the record itself — long
-- before anybody presses «смонтировать».
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap on purpose, as 010, 020, 030, 040 and 050 did:
-- milestones are written in parallel against this same repository, and two
-- migrations sharing a version is a merge nobody can resolve after either has
-- been applied.

-- Filled by the montage worker, exactly as `thumbnail_key`/`preview_key` are;
-- api only reads them out. Null is «the analysis has not looked yet» and not
-- «kept»: a gallery read before the worker got there must not show every
-- record as approved, which is why this is a nullable boolean and not a
-- `NOT NULL DEFAULT false`.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS screening_rejected boolean;
-- Why it was thrown out, in the worker's own vocabulary ('blurry',
-- 'exposure', 'duplicate' — the three things montage already measures — and
-- whatever it learns to see next); null for a frame it kept.
--
-- No CHECK on purpose, unlike `status` or `users.language`: those are values
-- api writes itself, while this one is the worker's, and a reason it learns to
-- name should not need a migration released from another repository first.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS screening_reason text;
