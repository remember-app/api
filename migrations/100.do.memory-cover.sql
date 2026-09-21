-- m-24 Memory settings: the frame the organizer puts on the face of a memory
-- (doc-01, «Обложка воспоминания — кадр из него, выбранный организатором; пока
-- не выбран, карточка в списке выглядит как сейчас»). Idempotent (see README
-- «Миграции»): the version mark is written as a separate query, and a process
-- killed between the two replays this file.
--
-- The number continues the tens, as 010…090 did: milestones are written in
-- parallel against this same repository, and two migrations sharing a version
-- is a merge nobody can resolve after either has been applied.

-- Null until the organizer picks one, and null again the moment that frame is
-- deleted: ON DELETE SET NULL is the whole of «удаление кадра снимает обложку».
-- The rule lives here and not in the delete route because material leaves a
-- memory by two paths — one record deleted, and everything a departing member
-- brought (`removeMedia`) — and a rule written in either of them is a rule the
-- other one forgets.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS cover_media_id uuid
  REFERENCES media_items (id) ON DELETE SET NULL;
