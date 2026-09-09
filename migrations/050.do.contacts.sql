-- m-18 Contacts: ники, которые человек сложил к себе, чтобы звать этих людей
-- в следующие воспоминания не набирая ник заново (doc-10).
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap on purpose, as 010, 020, 030 and 040 did: milestones
-- are written in parallel against this same repository, and two migrations
-- sharing a version is a merge nobody can resolve after either has been applied.

-- A one-way edge and nothing more: `contact_id` is not told, not asked, and
-- gains nothing by being here (doc-10). There is no reciprocal row, no state
-- and no request — a mutual pair is simply two independent rows.
CREATE TABLE IF NOT EXISTS contacts (
  owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- CASCADE on both ends and for two different reasons: a deleted account
  -- takes its own list with it, and it also disappears out of everybody
  -- else's — a contact is a pointer at a person, so it cannot outlive them.
  contact_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The primary key is also the promised uniqueness of the pair (saving the
  -- same person twice is not an error, it is the same row) and the index the
  -- list is read through, since `owner_id` leads it. No id of its own: nothing
  -- references this table, exactly as in auth_identities.
  PRIMARY KEY (owner_id, contact_id),
  -- Nobody is their own contact: the list exists to invite other people.
  CHECK (owner_id <> contact_id)
);
