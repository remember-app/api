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
    level text check (level in ('low', 'medium', 'high')),
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
