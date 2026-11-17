create table project_songs (
    project_id uuid not null references projects (id) on delete cascade,
    song_id uuid not null references songs (id) on delete cascade,
    added_by uuid references users (id) on delete set null,
    added_at timestamptz not null default now(),
    primary key (project_id, song_id)
);

create index project_songs_song_idx on project_songs (song_id);

insert into project_songs (project_id, song_id)
select project_id, id
from songs
where project_id is not null;

alter table songs
drop column project_id;
