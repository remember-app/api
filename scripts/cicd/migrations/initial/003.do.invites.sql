create extension if not exists pgcrypto;

create table invites (
    id uuid primary key default gen_random_uuid (),
    token text not null unique check (token ~ '^[0-9A-Z]{6}$'),
    kind text not null check (kind in ('memory', 'app')),
    created_by uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    max_uses integer check (
        max_uses is null
        or max_uses > 0
    ),
    used_count integer not null default 0 check (used_count >= 0),
    project_id uuid references projects (id) on delete cascade,
    role text check (
        role in (
            'admin',
            'contributor',
            'viewer'
        )
    ),
    check (
        (
            kind = 'memory'
            and project_id is not null
            and role is not null
        )
        or (
            kind = 'app'
            and project_id is null
        )
    )
);

create index invites_project_idx on invites (project_id)
where
    project_id is not null;

create unique index invites_one_live_memory_idx on invites (project_id)
where
    kind = 'memory'
    and revoked_at is null;

create unique index invites_one_live_app_idx on invites (created_by)
where
    kind = 'app'
    and revoked_at is null;

create table invite_uses (
    invite_id uuid not null references invites (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    used_at timestamptz not null default now(),
    primary key (invite_id, user_id)
);
