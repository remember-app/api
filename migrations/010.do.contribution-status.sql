-- m-6 Contribution Status: where each member stands on bringing their material.
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap on purpose: m-4 and m-5 are being written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied.

-- On the membership and not on the person (doc-06): the same human may have
-- brought everything to one memory and nothing to another.
--
--   not_started  invited, nothing uploaded and nothing said — the default
--   more_coming  brought something and is not finished; also what the api sets
--                itself when a member's first upload lands
--   done         said they have uploaded everything
--   nothing      said there will be no material from them at all
--
-- The last two are terminal, both are the member's own word, and only the
-- wording on screen tells them apart. There is no 'reminded' value: automatic
-- nudges are out of MVP (decision-03), and adding one is another migration.
ALTER TABLE memory_members ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'not_started';

-- Dropped before it is added, because ADD CONSTRAINT has no IF NOT EXISTS and
-- this file is replayed whole when a run dies before its version mark.
ALTER TABLE memory_members DROP CONSTRAINT IF EXISTS memory_members_status_check;
ALTER TABLE memory_members ADD CONSTRAINT memory_members_status_check
  CHECK (status IN ('not_started', 'more_coming', 'done', 'nothing'));
