create extension if not exists citext;

create table users (
    id         uuid primary key default gen_random_uuid(),
    username   citext unique,
    name       text,
    email      text,
    created_at timestamptz not null default now()
);

create table auth_identities (
    provider            text not null check (provider in ('email')),
    provider_account_id text not null,
    user_id             uuid not null references users (id) on delete cascade,
    created_at          timestamptz not null default now(),
    primary key (provider, provider_account_id)
);

create index auth_identities_user_idx on auth_identities (user_id);

create table auth_sessions (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users (id) on delete cascade,
    token_hash bytea not null unique,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz
);

create index auth_sessions_user_idx on auth_sessions (user_id);
create index auth_sessions_expires_idx on auth_sessions (expires_at);

create table auth_login_codes (
    user_id       uuid primary key references users (id) on delete cascade,
    code_hash     bytea not null,
    code_salt     bytea not null,
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null,
    attempts_left integer not null check (attempts_left >= 0)
);

create table projects (
    id          uuid primary key default gen_random_uuid(),
    title       text not null,
    event_start timestamptz not null,
    event_end   timestamptz,
    created_at  timestamptz not null default now(),
    check (event_end is null or event_end >= event_start)
);

create table project_members (
    project_id   uuid not null references projects (id) on delete cascade,
    user_id      uuid not null references users (id) on delete cascade,
    role         text not null check (role in ('admin', 'contributor', 'viewer')),
    contribution text not null default 'not_started'
        check (contribution in ('not_started', 'more_coming', 'done', 'nothing')),
    joined_at    timestamptz not null default now(),
    invited_by   uuid references users (id) on delete set null,
    primary key (project_id, user_id)
);

create index project_members_user_idx on project_members (user_id);

create table invites (
    id                            uuid primary key default gen_random_uuid(),
    token                         text not null unique,
    kind                          text not null check (kind in ('memory', 'app')),
    created_by                    uuid not null references users (id) on delete cascade,
    created_at                    timestamptz not null default now(),
    expires_at                    timestamptz,
    revoked_at                    timestamptz,
    max_uses                      integer check (max_uses is null or max_uses > 0),
    used_count                    integer not null default 0 check (used_count >= 0),
    project_id                    uuid references projects (id) on delete cascade,
    role                          text check (role in ('admin', 'contributor', 'viewer')),
    sender_reward_tokens          bigint,
    sender_reward_storage_bytes   bigint,
    invitee_reward_tokens         bigint,
    invitee_reward_storage_bytes  bigint,
    check (
        (kind = 'memory' and project_id is not null and role is not null)
        or (kind = 'app' and project_id is null)
    )
);

create index invites_project_idx on invites (project_id) where project_id is not null;
create unique index invites_one_live_memory_idx on invites (project_id)
    where kind = 'memory' and revoked_at is null;

create table invite_uses (
    invite_id uuid not null references invites (id) on delete cascade,
    user_id   uuid not null references users (id) on delete cascade,
    used_at   timestamptz not null default now(),
    primary key (invite_id, user_id)
);

create table labels (
    id          uuid primary key default gen_random_uuid(),
    project_id  uuid not null references projects (id) on delete cascade,
    owner_id    uuid not null references users (id) on delete cascade,
    name        text not null,
    color_hex   text not null check (color_hex ~ '^#[0-9a-fA-F]{6}$'),
    description text,
    shared      boolean not null default false,
    created_at  timestamptz not null default now()
);

create index labels_project_idx on labels (project_id);

create table media_items (
    id              uuid primary key default gen_random_uuid(),
    parent_media_id uuid references media_items (id),
    kind            text not null check (kind in ('photo', 'video', 'audio')),
    storage_key     text not null unique,
    uploaded_by     uuid references users (id) on delete set null,
    format          text not null,
    bytes           bigint not null check (bytes >= 0),
    width           integer,
    height          integer,
    duration        double precision,
    captured_at     timestamptz,
    camera_model    text,
    focal_length_mm double precision,
    aperture        double precision,
    iso             double precision,
    exposure_ev     double precision,
    shutter         text,
    latitude        double precision,
    longitude       double precision,
    place_edited_at timestamptz,
    created_at      timestamptz not null default now(),
    check ((latitude is null) = (longitude is null)),
    check (
        (kind = 'photo' and duration is null)
        or (kind = 'video')
        or (kind = 'audio' and width is null and height is null)
    )
);

create index media_items_uploaded_by_idx on media_items (uploaded_by);
create index media_items_parent_idx on media_items (parent_media_id);

create table project_items (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references projects (id) on delete cascade,
    media_id     uuid not null references media_items (id) on delete cascade,
    kind         text not null check (kind in ('photo', 'video', 'audio')),
    description  text,
    analysis     jsonb,
    thumbnail_id uuid references media_items (id) on delete set null,
    preview_id   uuid references media_items (id) on delete set null,
    created_at   timestamptz not null default now(),
    unique (project_id, media_id)
);

create index project_items_project_idx on project_items (project_id);
create index project_items_media_idx on project_items (media_id);

alter table projects
    add column cover_item_id uuid references project_items (id) on delete set null;

create table project_item_labels (
    project_item_id uuid not null references project_items (id) on delete cascade,
    label_id        uuid not null references labels (id) on delete cascade,
    primary key (project_item_id, label_id)
);

create index project_item_labels_label_idx on project_item_labels (label_id);

create table uploads (
    id               uuid primary key,
    project_id       uuid not null references projects (id) on delete cascade,
    uploaded_by      uuid not null references users (id) on delete cascade,
    kind             text not null check (kind in ('photo', 'video', 'audio')),
    storage_key      text not null unique,
    declared_bytes   bigint not null check (declared_bytes > 0),
    file_name        text not null,
    format           text not null,
    captured_at      timestamptz,
    duration_seconds double precision,
    status           text not null default 'pending'
        check (status in ('pending', 'uploading', 'completed', 'failed')),
    error_code       text,
    error            text,
    media_id         uuid references media_items (id) on delete cascade,
    multipart_id     text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create index uploads_project_idx on uploads (project_id);
create index uploads_media_idx on uploads (media_id);

create table songs (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    author      text not null,
    media_id    uuid not null references media_items (id) on delete cascade,
    project_id  uuid references projects (id) on delete cascade,
    uploaded_by uuid references users (id) on delete set null,
    created_at  timestamptz not null default now()
);

create index songs_project_idx on songs (project_id) where project_id is not null;

create table montage_templates (
    id                 uuid primary key default gen_random_uuid(),
    name               text not null,
    settings           jsonb not null,
    reference_media_id uuid references media_items (id) on delete set null
);

create table montages (
    id          uuid primary key default gen_random_uuid(),
    project_id  uuid not null references projects (id) on delete cascade,
    created_by  uuid not null references users (id) on delete cascade,
    status      text not null check (status in ('queued', 'processing', 'done', 'failed')),
    created_at  timestamptz not null default now(),
    error       text,
    template_id uuid references montage_templates (id) on delete set null,
    config      jsonb not null
);

create index montages_project_idx on montages (project_id, created_at desc);

create table montage_journal_entries (
    id         bigserial primary key,
    montage_id uuid not null references montages (id) on delete cascade,
    stage      text not null check (stage in ('prep', 'analysis', 'directing', 'music', 'assembly')),
    entry      jsonb not null,
    created_at timestamptz not null default now()
);

create index montage_journal_entries_montage_idx on montage_journal_entries (montage_id, id);

create table movies (
    id           uuid primary key default gen_random_uuid(),
    name         text not null,
    project_id   uuid not null references projects (id) on delete cascade,
    created_by   uuid not null references users (id) on delete cascade,
    created_at   timestamptz not null default now(),
    montage_id   uuid not null references montages (id) on delete cascade,
    video_id     uuid not null references media_items (id) on delete cascade,
    thumbnail_id uuid references media_items (id) on delete set null,
    preview_id   uuid references media_items (id) on delete set null
);

create index movies_project_idx on movies (project_id, created_at desc);

create table jobs (
    id         bigserial primary key,
    kind       text not null check (kind in ('media_derive', 'montage')),
    ref        uuid not null,
    status     text not null default 'queued'
        check (status in ('queued', 'running', 'done', 'failed')),
    attempts   integer not null default 0,
    run_after  timestamptz not null default now(),
    error      text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index jobs_due_idx on jobs (run_after) where status = 'queued';
create index jobs_running_idx on jobs (updated_at) where status = 'running';
create index jobs_ref_idx on jobs (ref);

create or replace function jobs_notify() returns trigger language plpgsql as $$
begin
    perform pg_notify('jobs', '');
    return null;
end;
$$;

create trigger jobs_notify after insert on jobs
    for each statement execute function jobs_notify();

create table push_tokens (
    token      text primary key,
    user_id    uuid not null references users (id) on delete cascade,
    platform   text not null check (platform in ('ios', 'android')),
    created_at timestamptz not null default now()
);

create index push_tokens_user_idx on push_tokens (user_id);

create table contacts (
    owner_id   uuid not null references users (id) on delete cascade,
    contact_id uuid not null references users (id) on delete cascade,
    name       text,
    created_at timestamptz not null default now(),
    primary key (owner_id, contact_id),
    check (owner_id <> contact_id)
);

create table user_limits (
    user_id       uuid primary key references users (id) on delete cascade,
    tokens        bigint not null default 0 check (tokens >= 0),
    storage_bytes bigint not null default 0 check (storage_bytes >= 0)
);
