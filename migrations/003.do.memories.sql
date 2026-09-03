-- m-0 Memory: memories, their members, invite links and device push tokens.
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.

CREATE TABLE IF NOT EXISTS memories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No ON DELETE: deleting a user must not silently take everyone else's
  -- shared material with it. doc-01 forbids deleting a memory at all in the
  -- MVP, so a user row that organizes one simply cannot be removed until
  -- account deletion exists and rules on this explicitly.
  organizer_id uuid NOT NULL REFERENCES users (id),
  title        text NOT NULL,
  -- timestamptz and not date: m-1 filters a member's gallery by capture time
  -- against this window, and a photo's captured_at is an instant. A bare date
  -- would be widened using the *server's* timezone, quietly shifting the
  -- window by hours for everyone who was not in it.
  event_start  timestamptz NOT NULL,
  event_end    timestamptz,
  -- Counters, kept on the row rather than counted per request; m-1 owns
  -- keeping them true when media starts arriving.
  storage_bytes  bigint  NOT NULL DEFAULT 0,
  media_count    integer NOT NULL DEFAULT 0,
  montage_count  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- An inverted window breaks nothing loudly — it makes m-1's gallery filter
  -- match nothing, with no way to see why. Cheap here, and a migration cannot
  -- be edited once applied.
  CONSTRAINT memories_event_range CHECK (event_end IS NULL OR event_end >= event_start)
);

-- Who is in a memory and at what level. The organizer holds a row here too,
-- written when the memory is created, so «memories I can see» is one join and
-- has no special case.
CREATE TABLE IF NOT EXISTS memory_members (
  memory_id  uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('organizer', 'contributor', 'viewer')),
  -- Null for the organizer, who invited nobody, and for a membership whose
  -- inviter has since been removed — the membership itself outlives them.
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One membership per person per memory; doubles as the index the permission
  -- check reads on every request to a memory.
  PRIMARY KEY (memory_id, user_id)
);
-- The other direction: the main screen is «every memory I am in».
CREATE INDEX IF NOT EXISTS memory_members_user_id_idx ON memory_members (user_id);

-- Invite links. Multi-use and without expiry (architecture.md): revoking is
-- marking the row and minting a new one.
CREATE TABLE IF NOT EXISTS invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id  uuid NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  -- The opaque random string out of the URL. UNIQUE is also the index the
  -- accept-by-link route looks through.
  token      text NOT NULL UNIQUE,
  -- No 'organizer': a memory has exactly one, its creator, and a link that
  -- handed out that role would hand out the right to exclude the creator.
  role       text NOT NULL CHECK (role IN ('contributor', 'viewer')),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- At most one live link per memory, enforced by the database rather than by
-- whoever writes the mint route: two live links is two answers to «what is the
-- link to this memory», and revoking then only stops one of them.
CREATE UNIQUE INDEX IF NOT EXISTS invites_one_active_idx
  ON invites (memory_id) WHERE revoked_at IS NULL;

-- Expo push tokens, one row per device.
CREATE TABLE IF NOT EXISTS push_tokens (
  -- The token is the identity of the device, so it is the key: registering
  -- the same one twice is an upsert, not a duplicate.
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Sending a notification starts from the person, not the device.
CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx ON push_tokens (user_id);
