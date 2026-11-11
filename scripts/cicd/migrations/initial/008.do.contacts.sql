create table contacts (
    owner_id uuid not null references users (id) on delete cascade,
    contact_id uuid not null references users (id) on delete cascade,
    name text,
    created_at timestamptz not null default now(),
    primary key (owner_id, contact_id),
    check (owner_id <> contact_id)
);
