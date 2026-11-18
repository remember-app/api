create table montage_templates (
    id uuid primary key default gen_random_uuid (),
    about jsonb not null check (jsonb_typeof (about) = 'object'),
    settings jsonb not null,
    reference_media_id uuid references media_items (id) on delete set null,
    cover_id uuid references media_items (id) on delete set null
);
