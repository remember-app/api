create table media_items (
    id uuid primary key default gen_random_uuid (),
    kind text not null check (
        kind in ('photo', 'video', 'audio')
    ),
    storage_key text not null unique,
    format text not null,
    bytes bigint not null check (bytes >= 0),
    fingerprint text not null default '',
    perceptual_hash text not null default '',
    meta jsonb not null default '{}'::jsonb check (
        jsonb_typeof(meta) = 'object'
        and (
            meta->'place' is null
            or meta->'place' = 'null'::jsonb
            or (meta->'place' ? 'latitude' and meta->'place' ? 'longitude')
        )
        and (
            meta->'dimensions' is null
            or meta->'dimensions' = 'null'::jsonb
            or (meta->'dimensions' ? 'width' and meta->'dimensions' ? 'height')
        )
        and (kind <> 'photo' or meta->>'duration' is null)
        and (kind <> 'audio' or meta->'dimensions' is null)
    )
);

create index media_items_fingerprint_idx on media_items (fingerprint)
where
    fingerprint <> '';

alter table users
add constraint users_profile_media_fk foreign key (profile_media_id) references media_items (id) on delete set null;
