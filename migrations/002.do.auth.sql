-- m-3 Accounts: identity and sessions.
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.

CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unset until the person claims one (claiming and changing it is another
  -- card). citext comes from migration 001: uniqueness ignores case.
  username   citext UNIQUE,
  name       text,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sign-in bindings. One user, many providers; for magic-link that is a row
-- with provider = 'email' and the lowercased address as the provider's id.
CREATE TABLE IF NOT EXISTS auth_identities (
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider            text NOT NULL,
  provider_account_id text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- The primary key is also the promised uniqueness of the pair: no separate
  -- id is needed, nothing references this table.
  PRIMARY KEY (provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id);

-- A session is an opaque random token; the database holds only its SHA-256.
CREATE TABLE IF NOT EXISTS sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- UNIQUE doubles as the index every authenticated request looks through.
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

-- Magic-link tokens: they live for minutes and are extinguished at the moment
-- of use (DELETE ... RETURNING), so a row here is exactly one unspent sign-in.
CREATE TABLE IF NOT EXISTS email_login_tokens (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
