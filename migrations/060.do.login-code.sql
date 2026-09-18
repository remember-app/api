-- m-22 Code sign-in: шестизначный код в письме вместо ссылки входа.
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap on purpose, as 010, 020, 030, 040 and 050 did:
-- milestones are written in parallel against this same repository, and two
-- migrations sharing a version is a merge nobody can resolve after either has
-- been applied.

-- The link tokens go out with the links they were. Nothing is carried over and
-- nothing needs to be: a row here lived minutes and was one unspent sign-in, so
-- the whole cost of this line is that somebody holding an unopened letter at
-- the moment of the deploy asks for a code instead.
DROP TABLE IF EXISTS email_login_tokens;

-- One live code per person — that is what the primary key on `user_id` says,
-- and it is a security property rather than tidiness: a fresh request replaces
-- the previous code instead of adding a second one, so the guesses that stand
-- open against an address at any moment are one code's worth and not one per
-- request the attacker managed to make.
CREATE TABLE IF NOT EXISTS email_login_codes (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- scrypt, salted per row, and not the bare SHA-256 a session token gets (see
  -- `hashToken` in src/auth/session.ts). The reasoning there is explicit about
  -- why it is enough — 32 random bytes have nothing to guess — and a six-digit
  -- code is the opposite case: it is one of a million. Unsalted, a million
  -- hashes computed once would read every row in this table forever; the salt
  -- makes that work per row, and scrypt makes each of the million tries cost
  -- real time and memory. A stolen dump is then not a stolen sign-in.
  code_salt  bytea NOT NULL,
  code_hash  bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Counts down on every attempt, and at zero the row is dead — to the right
  -- code as much as to a wrong one. This column is the whole reason a secret
  -- small enough for a person to retype can be allowed to exist at all:
  -- without it, a script walks the million.
  attempts_left integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
