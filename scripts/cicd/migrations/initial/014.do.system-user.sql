insert into
    users (
        id,
        username,
        name,
        email,
        language,
        registered
    )
values (
        '00000000-0000-4000-8000-000000000000',
        'system',
        'System',
        'system@',
        'en',
        true
    )
on conflict (id) do nothing;

do $$
declare
    alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    candidate text;
begin
    loop
        select string_agg(
            substr(alphabet, (get_byte(raw, i) % 36) + 1, 1),
            '' order by i
        )
        into candidate
        from (select gen_random_bytes(6) as raw) as bytes,
             generate_series(0, 5) as i;
        exit when not exists (select 1 from invites where token = candidate);
    end loop;
    insert into invites (token, kind, created_by, max_uses, expires_at)
    values (candidate, 'app', '00000000-0000-4000-8000-000000000000', 1, null);
end $$;