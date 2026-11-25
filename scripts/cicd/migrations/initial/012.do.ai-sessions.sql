create table ai_sessions (
    id bigserial primary key,
    job_id bigint not null references jobs (id) on delete cascade,
    operation text not null check (
        operation in ('photo', 'video', 'audio', 'text')
    ),
    provider text not null,
    model text not null,
    status text not null check (
        status in ('ok', 'failed')
    ),
    usage jsonb not null default '{}'::jsonb check (
        jsonb_typeof(usage) = 'object'
    ),
    error text,
    transcript jsonb not null default '[]'::jsonb check (
        jsonb_typeof(transcript) = 'array'
    ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index ai_sessions_job_idx on ai_sessions (job_id);

create index ai_sessions_created_idx on ai_sessions (created_at);
