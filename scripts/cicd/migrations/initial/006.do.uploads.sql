create table uploads (
    id uuid primary key,
    project_id uuid references projects (id) on delete cascade,
    uploaded_by uuid not null references users (id) on delete cascade,
    kind text not null check (
        kind in ('photo', 'video', 'audio')
    ),
    storage_key text not null unique,
    status text not null default 'pending' check (
        status in (
            'pending',
            'uploading',
            'completed',
            'failed'
        )
    ),
    file jsonb not null default '{}'::jsonb check (
        jsonb_typeof(file) = 'object'
        and file ? 'name'
        and file ? 'format'
        and file ? 'bytes'
        and (file->>'bytes')::numeric > 0
    ),
    failure jsonb check (
        failure is null
        or jsonb_typeof(failure) = 'object'
    ),
    media_id uuid references media_items (id) on delete cascade,
    multipart_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index uploads_project_idx on uploads (project_id);

create index uploads_media_idx on uploads (media_id);
