create table media_items (
    id uuid primary key default gen_random_uuid (),
    parent_media_id uuid references media_items (id),
    kind text not null check (
        kind in ('photo', 'video', 'audio')
    ),
    storage_key text not null unique,
    uploaded_by uuid references users (id) on delete set null,
    format text not null,
    bytes bigint not null check (bytes >= 0),
    width integer,
    height integer,
    duration double precision,
    captured_at timestamptz,
    camera_model text,
    focal_length_mm double precision,
    aperture double precision,
    iso double precision,
    exposure_ev double precision,
    shutter text,
    latitude double precision,
    longitude double precision,
    place_edited_at timestamptz,
    created_at timestamptz not null default now(),
    check (
        (latitude is null) = (longitude is null)
    ),
    check (
        (
            kind = 'photo'
            and duration is null
        )
        or (kind = 'video')
        or (
            kind = 'audio'
            and width is null
            and height is null
        )
    )
);

create index media_items_uploaded_by_idx on media_items (uploaded_by);

create index media_items_parent_idx on media_items (parent_media_id);

alter table users
add constraint users_profile_media_fk foreign key (profile_media_id) references media_items (id) on delete set null;

create table project_items (
    id uuid primary key default gen_random_uuid (),
    project_id uuid not null references projects (id) on delete cascade,
    media_id uuid not null references media_items (id) on delete cascade,
    kind text not null check (
        kind in ('photo', 'video', 'audio')
    ),
    description text,
    analysis jsonb,
    thumbnail_id uuid references media_items (id) on delete set null,
    preview_id uuid references media_items (id) on delete set null,
    created_at timestamptz not null default now(),
    unique (project_id, media_id)
);

create index project_items_project_idx on project_items (project_id);

create index project_items_media_idx on project_items (media_id);

create table project_item_labels (
    project_item_id uuid not null references project_items (id) on delete cascade,
    label_id uuid not null references labels (id) on delete cascade,
    primary key (project_item_id, label_id)
);

create index project_item_labels_label_idx on project_item_labels (label_id);

create table uploads (
    id uuid primary key,
    project_id uuid not null references projects (id) on delete cascade,
    uploaded_by uuid not null references users (id) on delete cascade,
    kind text not null check (
        kind in ('photo', 'video', 'audio')
    ),
    storage_key text not null unique,
    declared_bytes bigint not null check (declared_bytes > 0),
    file_name text not null,
    format text not null,
    captured_at timestamptz,
    duration_seconds double precision,
    status text not null default 'pending' check (
        status in (
            'pending',
            'uploading',
            'completed',
            'failed'
        )
    ),
    error_code text,
    error text,
    media_id uuid references media_items (id) on delete cascade,
    multipart_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index uploads_project_idx on uploads (project_id);

create index uploads_media_idx on uploads (media_id);
