create table jobs (
    id bigserial primary key,
    kind text not null check (
        kind in (
            'media_derive',
            'media_analysis',
            'montage'
        )
    ),
    ref uuid not null,
    depends_on bigint[],
    status text not null default 'queued' check (
        status in (
            'queued',
            'running',
            'done',
            'failed'
        )
    ),
    attempts integer not null default 0,
    run_after timestamptz not null default now(),
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index jobs_due_idx on jobs (run_after)
where
    status = 'queued';

create index jobs_running_idx on jobs (updated_at)
where
    status = 'running';

create index jobs_ref_idx on jobs (ref);

create or replace function jobs_notify() returns trigger language plpgsql as $$
begin
    perform pg_notify('jobs', '');
    return null;
end;
$$;

create trigger jobs_notify after insert on jobs
    for each statement execute function jobs_notify();

create table ai_requests (
    id bigserial primary key,
    media_id uuid references media_items (id) on delete set null,
    montage_id uuid references montages (id) on delete set null,
    operation text not null check (
        operation in ('photo', 'video', 'audio', 'text')
    ),
    provider text not null,
    model text not null,
    status text not null check (
        status in ('ok', 'failed')
    ),
    input_tokens integer,
    output_tokens integer,
    total_tokens integer,
    cached_tokens integer,
    reasoning_tokens integer,
    duration integer,
    cost_usd numeric(14, 8),
    error text,
    created_at timestamptz not null default now()
);

create index ai_requests_media_idx on ai_requests (media_id);

create index ai_requests_montage_idx on ai_requests (montage_id);

create index ai_requests_created_idx on ai_requests (created_at);
