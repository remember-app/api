create table project_items (
    id uuid primary key default gen_random_uuid (),
    project_id uuid not null references projects (id) on delete cascade,
    uploaded_by uuid not null references users (id) on delete cascade,
    kind text not null check (
        kind in ('photo', 'video', 'audio')
    ),
    comment text,
    analysis jsonb,
    original_id uuid not null references media_items (id) on delete cascade,
    compressed_id uuid references media_items (id) on delete set null,
    previews_ids jsonb check (
        previews_ids is null
        or jsonb_typeof(previews_ids) = 'object'
    ),
    created_at timestamptz not null default now(),
    unique (project_id, original_id)
);

create index project_items_project_idx on project_items (project_id);

create index project_items_original_idx on project_items (original_id);

create table project_item_labels (
    project_item_id uuid not null references project_items (id) on delete cascade,
    label_id uuid not null references labels (id) on delete cascade,
    primary key (project_item_id, label_id)
);

create index project_item_labels_label_idx on project_item_labels (label_id);
