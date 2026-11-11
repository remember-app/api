create table push_tokens (
    token text primary key,
    user_id uuid not null references users (id) on delete cascade,
    platform text not null check (
        platform in ('ios', 'android')
    ),
    created_at timestamptz not null default now()
);

create index push_tokens_user_idx on push_tokens (user_id);
