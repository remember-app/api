alter table songs
    add column cover_id uuid references media_items (id) on delete set null,
    add column description text;

alter table montage_templates
    add column cover_id uuid references media_items (id) on delete set null,
    add column description text;
