create table movies (
    id uuid primary key default gen_random_uuid (),
    name text not null,
    project_id uuid not null references projects (id) on delete cascade,
    created_by uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    montage_id uuid not null references montages (id) on delete cascade,
    original_id uuid not null references media_items (id) on delete cascade,
    compressed_id uuid references media_items (id) on delete set null,
    preview_id uuid references media_items (id) on delete set null
);

create index movies_project_idx on movies (project_id, created_at desc);
