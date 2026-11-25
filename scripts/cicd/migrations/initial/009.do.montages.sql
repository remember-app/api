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
