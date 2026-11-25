create table projects (
    id uuid primary key default gen_random_uuid (),
    title text not null,
    description text not null default '' check (char_length(description) <= 2000),
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

create table labels (
    id uuid primary key default gen_random_uuid (),
    project_id uuid not null references projects (id) on delete cascade,
    owner_id uuid not null references users (id) on delete cascade,
    name text not null,
    color text not null check (
        color ~ '^#[0-9a-fA-F]{6}$'
    )
);

create index labels_project_idx on labels (project_id);
