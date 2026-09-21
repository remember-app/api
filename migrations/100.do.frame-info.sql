-- m-24 Frame info: «Сведения о кадре» (doc-02) — what one frame is beyond the
-- picture itself: the file it arrived as, the camera that took it, the place it
-- was taken at, and which finished montages it stands in.
-- Idempotent (see README «Миграции»): the version mark is written as a
-- separate query, and a process killed between the two replays this file.
--
-- The number leaves a gap, as 010 … 090 did: milestones are written in parallel
-- against this same repository, and two migrations sharing a version is a merge
-- nobody can resolve after either has been applied.

-- The name the file had on the phone, sent with the upload intent and kept as
-- it came. Null for everything uploaded before the app started sending it: the
-- sheet leaves the line out rather than showing an empty one.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS file_name text;

-- The camera, read by the montage worker out of the original's metadata —
-- exactly as `width` and `height` are. api writes none of these, it only hands
-- them out; null is «ещё не посмотрели» or «в файле этого нет», and the two are
-- the same to the reader.
--
-- Three columns rather than one ready-made «iPhone 15 Pro · 24 мм · f/1.8»: the
-- units in that line are words, the app puts them in the reader's own language
-- (`users.language`), and a string assembled in the worker's repository would
-- freeze one language into this database.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS camera_model text;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS focal_length_mm double precision;
-- The f-number, so `1.8` is what the app shows as «f/1.8».
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS aperture double precision;

-- Where it was shot — and the place *is* the coordinates. Turning them into
-- «Усадьба Остафьево» takes an outside geocoder, which is a paid service and a
-- registration; whether the product wants a name at all is a question for the
-- chief and not something to guess at in a migration (TASK-191).
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS longitude double precision;

-- Where each frame stands in each assembled video. Written by the montage
-- worker while it cuts one; api only reads it, to answer «в каких роликах этот
-- кадр и на какой секунде».
--
-- A table of its own rather than a list inside `montages.params` or on the
-- media row: the fact belongs to the *pair*, and both halves of it can leave
-- independently — a frame deleted from the gallery must not stay listed in a
-- video's layout, and a video deleted must not stay listed under a frame. Two
-- foreign keys say that once; a JSON array would leave both cleanups to
-- whoever remembers.
--
-- One table for the whole of m-24 and its neighbours: this is the layout of a
-- montage, and a second copy of it in another milestone's journal would be two
-- answers to «на какой секунде стоит кадр».
CREATE TABLE IF NOT EXISTS montage_frames (
  montage_id       uuid NOT NULL REFERENCES montages (id) ON DELETE CASCADE,
  media_id         uuid NOT NULL REFERENCES media_items (id) ON DELETE CASCADE,
  -- Where the frame starts inside the video, and how long it is held there.
  -- Seconds and fractions of one, as `montages.duration_seconds` is.
  start_seconds    double precision NOT NULL,
  duration_seconds double precision NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- The start is part of the key because one frame may legitimately stand in a
  -- video twice — a clip cut in two, a photo that comes back at the end — and
  -- the pair alone would make the worker choose which of the two to keep.
  PRIMARY KEY (montage_id, media_id, start_seconds)
);
-- The other direction, which is the only way api reads this table: «в каких
-- роликах стоит вот этот кадр». The primary key already serves the worker's
-- own «чем набран вот этот ролик».
CREATE INDEX IF NOT EXISTS montage_frames_media_idx ON montage_frames (media_id);
