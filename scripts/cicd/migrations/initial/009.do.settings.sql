create table settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now()
);