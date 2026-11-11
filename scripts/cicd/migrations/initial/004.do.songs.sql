create table songs (
    id uuid primary key default gen_random_uuid (),
    name text not null,
    author text not null,
    media_id uuid not null references media_items (id) on delete cascade,
    project_id uuid references projects (id) on delete cascade,
    uploaded_by uuid references users (id) on delete set null,
    analysis jsonb,
    created_at timestamptz not null default now()
);

create index songs_project_idx on songs (project_id)
where
    project_id is not null;
