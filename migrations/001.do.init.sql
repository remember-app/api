-- No product tables live here: every feature ships its own migration.
-- citext backs the case-insensitive unique username (architecture.md).
CREATE EXTENSION IF NOT EXISTS citext;
