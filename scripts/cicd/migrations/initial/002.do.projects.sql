create table projects (
    id uuid primary key default gen_random_uuid (),
    title text not null,
    event_start timestamptz not null,
    event_end timestamptz,
    tokens bigint not null default 0 check (tokens >= 0),
    tokens_spend bigint not null default 0 check (tokens_spend >= 0),
    storage_bytes bigint not null default 0 check (storage_bytes >= 0),
    storage_spend bigint not null default 0 check (storage_spend >= 0),
    created_at timestamptz not null default now(),
    check (
        event_end is null
        or event_end >= event_start
    )
);

create table project_members (
    project_id uuid not null references projects (id) on delete cascade,
    user_id uuid not null references users (id) on delete cascade,
    role text not null check (
        role in (
            'admin',
            'contributor',
            'viewer'
        )
    ),
    contribution text not null default 'not_started' check (
        contribution in (
            'not_started',
            'more_coming',
            'done'
        )
    ),
    tokens bigint not null default 0 check (tokens >= 0),
    tokens_spend bigint not null default 0 check (tokens_spend >= 0),
    storage_bytes bigint not null default 0 check (storage_bytes >= 0),
    storage_spend bigint not null default 0 check (storage_spend >= 0),
    joined_at timestamptz not null default now(),
    invited_by uuid references users (id) on delete set null,
    primary key (project_id, user_id)
);

create index project_members_user_idx on project_members (user_id);

create table invites (
    id uuid primary key default gen_random_uuid (),
    token text not null unique check (char_length(token) = 6),
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

create table labels (
    id uuid primary key default gen_random_uuid (),
    project_id uuid not null references projects (id) on delete cascade,
    owner_id uuid not null references users (id) on delete cascade,
    name text not null,
    color_hex text not null check (
        color_hex ~ '^#[0-9a-fA-F]{6}$'
    ),
    description text,
    shared boolean not null default false,
    created_at timestamptz not null default now()
);

create index labels_project_idx on labels (project_id);
