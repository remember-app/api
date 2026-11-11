create extension if not exists citext;

create table users (
    id uuid primary key default gen_random_uuid (),
    username citext not null unique,
    name text not null default '',
    email text not null,
    language text not null default 'en' check (language in ('en', 'ru')),
    registered boolean not null default false,
    profile_media_id uuid,
    tokens bigint not null default 0 check (tokens >= 0),
    tokens_spend bigint not null default 0 check (tokens_spend >= 0),
    storage_bytes bigint not null default 0 check (storage_bytes >= 0),
    storage_spend bigint not null default 0 check (storage_spend >= 0),
    created_at timestamptz not null default now()
);

create table auth_identities (
    provider text not null check (provider in ('email')),
    provider_account_id text not null,
    user_id uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (provider, provider_account_id)
);

create index auth_identities_user_idx on auth_identities (user_id);

create table auth_sessions (
    id uuid primary key default gen_random_uuid (),
    user_id uuid not null references users (id) on delete cascade,
    token_hash bytea not null unique,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz
);

create index auth_sessions_user_idx on auth_sessions (user_id);

create index auth_sessions_expires_idx on auth_sessions (expires_at);

create table auth_login_codes (
    user_id uuid primary key references users (id) on delete cascade,
    code_hash bytea not null,
    code_salt bytea not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    attempts_left integer not null check (attempts_left >= 0)
);
