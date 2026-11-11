alter table media_items
    add column fingerprint text not null default '';

create index media_items_fingerprint_idx on media_items (fingerprint)
where
    fingerprint <> '';

alter table uploads
    add column fingerprint text;
