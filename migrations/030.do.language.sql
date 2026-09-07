-- m-13 Language: the language a person reads the product in (doc-8).
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap on purpose, as 010 and 020 did: milestones are
-- written in parallel against this same repository, and two migrations sharing
-- a version is a merge nobody can resolve after either has been applied.

-- Exactly two values and no third (doc-8), spelled as the BCP 47 subtags the
-- phone already reports.
--
-- On the person, not on the device: a push about a memory goes to all its
-- members at once, so the text is composed with no request of theirs in hand
-- and the language has to be readable straight off the row. NOT NULL with a
-- default for the same reason — there is no recipient without a language to
-- write in.
--
-- 'ru' is that default because it is the language the product itself is
-- written in: the kit's dictionary and the sign-in email are Russian. It shows
-- only in the window between an account being made and the app posting the
-- phone's language, which it does right after signing in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'ru';

-- Dropped before it is added, because ADD CONSTRAINT has no IF NOT EXISTS and
-- this file is replayed whole when a run dies before its version mark.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_language_check;
ALTER TABLE users ADD CONSTRAINT users_language_check CHECK (language IN ('ru', 'en'));
