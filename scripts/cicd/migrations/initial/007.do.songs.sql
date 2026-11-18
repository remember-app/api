create table songs (
    id uuid primary key default gen_random_uuid (),
    name text not null,
    author text,
    original_id uuid not null references media_items (id) on delete cascade,
    compressed_id uuid references media_items (id) on delete set null,
    cover_id uuid references media_items (id) on delete set null,
    preview_cover_id uuid references media_items (id) on delete set null,
    uploaded_by uuid references users (id) on delete set null,
    analysis jsonb,
    created_at timestamptz not null default now()
);

create table project_songs (
    project_id uuid not null references projects (id) on delete cascade,
    song_id uuid not null references songs (id) on delete cascade,
    added_by uuid references users (id) on delete set null,
    added_at timestamptz not null default now(),
    primary key (project_id, song_id)
);

create index project_songs_song_idx on project_songs (song_id);
