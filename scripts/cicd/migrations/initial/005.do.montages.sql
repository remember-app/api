create table montage_templates (
    id uuid primary key default gen_random_uuid (),
    name text not null,
    settings jsonb not null,
    reference_media_id uuid references media_items (id) on delete set null
);

create table montages (
    id uuid primary key default gen_random_uuid (),
    project_id uuid not null references projects (id) on delete cascade,
    created_by uuid not null references users (id) on delete cascade,
    status text not null check (
        status in (
            'queued',
            'processing',
            'done',
            'failed'
        )
    ),
    created_at timestamptz not null default now(),
    error text,
    manifest jsonb not null,
    journal jsonb not null default '{"directing": null}'::jsonb
);

create index montages_project_idx on montages (project_id, created_at desc);

create table movies (
    id uuid primary key default gen_random_uuid (),
    name text not null,
    project_id uuid not null references projects (id) on delete cascade,
    created_by uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    montage_id uuid not null references montages (id) on delete cascade,
    video_id uuid not null references media_items (id) on delete cascade,
    thumbnail_id uuid references media_items (id) on delete set null,
    preview_id uuid references media_items (id) on delete set null
);

create index movies_project_idx on movies (project_id, created_at desc);
