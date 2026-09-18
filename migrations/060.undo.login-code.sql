DROP TABLE IF EXISTS email_login_codes;

-- Back to exactly what 002 created: undoing this migration means the code that
-- runs afterwards is the code that mints link tokens, and it needs somewhere to
-- put them. Nothing is restored into it — the rows lived minutes and are gone.
CREATE TABLE IF NOT EXISTS email_login_tokens (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
