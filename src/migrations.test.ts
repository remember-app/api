import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, expect, test } from "vitest";
import { sql } from "./db.ts";

/**
 * Migrations 100 (frame info), 110 (memory cover), 140 (dates between
 * days) and 150 (hidden frame, place set by hand): the three promises the
 * docs/running.md makes of every migration and that no route can show — a replay is
 * harmless (a process killed between the file and its version mark runs it
 * again), an undo puts the schema back as it found it, and a redo gives the
 * same schema and the same behaviour as the first run.
 *
 * Not run against the shared database: dropping a column there would break every
 * other test file running beside this one. Each test builds the chain in a
 * database of its own and drops it afterwards, so it needs the right to create
 * one (the local Postgres from docker-compose gives it). A schema of its own in
 * the shared database was tried first and is not safe: a `DROP TABLE IF EXISTS`
 * that finds nothing in the scratch schema goes on down the `search_path` and
 * drops the real table in `public`.
 */

/** A database and a dozen migrations are not a five-second promise on a busy machine. */
const slow = 30_000;

const dir = new URL("../migrations/", import.meta.url);
const files = readdirSync(dir);
const versionOf = (file: string) => Number.parseInt(file, 10);

/** One migration file's text, by its number and direction. */
function script(version: number, way: "do" | "undo") {
  const name = files.find((f) => versionOf(f) === version && f.split(".")[1] === way);
  if (!name) throw new Error(`no ${way} file for migration ${version}`);
  return readFileSync(new URL(name, dir), "utf8");
}

const versions = files
  .filter((f) => f.split(".")[1] === "do")
  .map(versionOf)
  .sort((a, b) => a - b);

const made: { name: string; db: postgres.Sql }[] = [];

afterAll(async () => {
  for (const { name, db } of made) {
    await db.end();
    await sql.unsafe(`drop database if exists ${name} with (force)`);
  }
  await sql.end();
});

/** An empty database with every migration below `below` already applied, in order. */
async function chain(below: number) {
  const name = `migtest_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`create database ${name}`);
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${name}`;
  // «extension already exists, skipping» and its like: noise, not news.
  const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
  made.push({ name, db });

  const apply = (version: number, way: "do" | "undo") => db.unsafe(script(version, way)).simple();
  for (const version of versions.filter((v) => v < below)) await apply(version, "do");

  /** Everything a migration can change about the schema, as text to compare. */
  const shape = async () => ({
    columns: await db`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'public'
      order by table_name, column_name
    `,
    constraints: await db`
      select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def
      from pg_constraint where connamespace = 'public'::regnamespace
      order by conrelid::regclass::text, conname
    `,
    indexes: await db`
      select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname
    `,
  });

  return { db, apply, shape };
}

/** A user with a memory and one finished photo in it — the rows every migration here hangs off. */
async function seed(db: postgres.Sql) {
  const [user] = await db<{ id: string }[]>`
    insert into users (email) values (${`mig-${randomUUID()}@example.com`}) returning id
  `;
  if (!user) throw new Error("no user");
  const [memory] = await db<{ id: string }[]>`
    insert into memories (organizer_id, title, event_start)
    values (${user.id}, 'migration', now()) returning id
  `;
  if (!memory) throw new Error("no memory");
  const photo = async () => {
    const [row] = await db<{ id: string }[]>`
      insert into media_items (memory_id, uploaded_by, kind, status, original_key, size_bytes)
      values (${memory.id}, ${user.id}, 'photo', 'ready', ${`k/${randomUUID()}`}, 1)
      returning id
    `;
    if (!row) throw new Error("no media row");
    return row.id;
  };
  return { user: user.id, memory: memory.id, photo };
}

test(
  "100 frame-info: a replay keeps what the worker wrote, an undo restores the old schema, a redo the new one",
  async () => {
    const { db, apply, shape } = await chain(100);
    const before = await shape();

    await apply(100, "do");
    const after = await shape();
    // It did change something — otherwise the equalities below prove nothing.
    expect(after).not.toEqual(before);
    expect(after.columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(["file_name", "camera_model", "aperture", "latitude", "montage_id"]),
    );

    // A frame with everything the worker fills in, standing in a video.
    const { user, memory, photo } = await seed(db);
    const media = await photo();
    await db`
    update media_items set file_name = 'IMG_4471.HEIC', camera_model = 'iPhone 15 Pro',
      focal_length_mm = 24, aperture = 1.8, latitude = 55.5, longitude = 37.5
    where id = ${media}
  `;
    const [montage] = await db<{ id: string }[]>`
    insert into montages (memory_id, ordered_by, status) values (${memory}, ${user}, 'ready')
    returning id
  `;
    if (!montage) throw new Error("no montage");
    await db`
    insert into montage_frames (montage_id, media_id, start_seconds, duration_seconds)
    values (${montage.id}, ${media}, 12.5, 3)
  `;
    const held = async () => ({
      frame: await db`
      select file_name, camera_model, focal_length_mm, aperture, latitude, longitude
      from media_items where id = ${media}
    `,
      layout: await db`select start_seconds, duration_seconds from montage_frames`,
    });
    const written = await held();
    expect(written.frame).toHaveLength(1);
    expect(written.layout).toEqual([{ start_seconds: 12.5, duration_seconds: 3 }]);

    // The replay: same schema, and not one value lost — a `DROP … ; ADD …` in
    // place of `IF NOT EXISTS` would pass the first half and fail this half.
    await apply(100, "do");
    expect(await shape()).toEqual(after);
    expect(await held()).toEqual(written);

    // The undo: the schema is what it was before 100 (a column or a table the
    // undo forgot shows up as a difference), and what api owned stays.
    await apply(100, "undo");
    expect(await shape()).toEqual(before);
    const [left] = await db`select count(*)::int as n from media_items where id = ${media}`;
    expect(left?.n).toBe(1);
    // An undo that fails on a second go is a redo nobody can script.
    await apply(100, "undo");
    expect(await shape()).toEqual(before);

    // The redo: the very schema the first run made.
    await apply(100, "do");
    expect(await shape()).toEqual(after);
  },
  slow,
);

test(
  "110 memory-cover: a replay keeps the cover, an undo restores the old schema, a redo brings back the rule that deleting the frame takes the cover off",
  async () => {
    const { db, apply, shape } = await chain(110);
    const before = await shape();

    await apply(110, "do");
    const after = await shape();
    expect(after).not.toEqual(before);
    expect(
      after.columns.filter((c) => c.table_name === "memories").map((c) => c.column_name),
    ).toContain("cover_media_id");

    const { memory, photo } = await seed(db);
    const coverOf = async () => {
      const [row] = await db<{ cover_media_id: string | null }[]>`
      select cover_media_id from memories where id = ${memory}
    `;
      return row?.cover_media_id;
    };
    const chosen = await photo();
    await db`update memories set cover_media_id = ${chosen} where id = ${memory}`;

    // The replay changes nothing, and the cover already chosen is still chosen.
    await apply(110, "do");
    expect(await shape()).toEqual(after);
    expect(await coverOf()).toBe(chosen);

    // The rule lives in the column's foreign key: the frame goes, the memory
    // stays, and its cover is null again. Deleted straight from the table on
    // purpose — the two routes that delete media both end up here.
    await db`delete from media_items where id = ${chosen}`;
    expect(await coverOf()).toBeNull();

    await apply(110, "undo");
    expect(await shape()).toEqual(before);
    const [kept] = await db`select count(*)::int as n from memories where id = ${memory}`;
    expect(kept?.n).toBe(1);
    await apply(110, "undo");
    expect(await shape()).toEqual(before);

    // The redo is the same schema — and the rule works again, which a column
    // brought back without its ON DELETE SET NULL would not.
    await apply(110, "do");
    expect(await shape()).toEqual(after);
    const again = await photo();
    await db`update memories set cover_media_id = ${again} where id = ${memory}`;
    await db`delete from media_items where id = ${again}`;
    expect(await coverOf()).toBeNull();
  },
  slow,
);

test(
  "140 dates-between-days: accounts made before it start switched off, a replay keeps every choice, an undo restores the old schema and keeps the accounts, a redo starts everyone off",
  async () => {
    const { db, apply, shape } = await chain(140);
    const before = await shape();
    const person = async () => {
      const [row] = await db<{ id: string }[]>`
        insert into users (email) values (${`mig-${randomUUID()}@example.com`}) returning id
      `;
      if (!row) throw new Error("no user");
      return row.id;
    };
    // Two accounts that were there before the setting existed.
    const early = await person();
    const other = await person();

    await apply(140, "do");
    const after = await shape();
    expect(after).not.toEqual(before);
    const setting = after.columns.find(
      (c) => c.table_name === "users" && c.column_name === "dates_between_days",
    );
    expect(setting).toMatchObject({ data_type: "boolean", is_nullable: "NO" });

    const switches = async () =>
      new Map(
        (
          await db<{ id: string; dates_between_days: boolean }[]>`
            select id, dates_between_days from users
          `
        ).map((row) => [row.id, row.dates_between_days]),
      );
    // Off for the accounts that were there and for one made afterwards, and
    // «not set» is not a state the column can hold.
    const fresh = await person();
    expect(await switches()).toEqual(
      new Map([
        [early, false],
        [other, false],
        [fresh, false],
      ]),
    );
    await expect(
      db`update users set dates_between_days = null where id = ${early}`,
    ).rejects.toThrow();

    // The replay: same schema, and the choice already made is still made — a
    // `DROP … ; ADD …` in place of `IF NOT EXISTS` would switch everyone off.
    await db`update users set dates_between_days = true where id = ${early}`;
    await apply(140, "do");
    expect(await shape()).toEqual(after);
    expect((await switches()).get(early)).toBe(true);
    expect((await switches()).get(other)).toBe(false);

    // The undo: the schema is what it was before 140, nobody is lost, and an
    // undo that fails on a second go is a redo nobody can script.
    await apply(140, "undo");
    expect(await shape()).toEqual(before);
    const [left] = await db`select count(*)::int as n from users`;
    expect(left?.n).toBe(3);
    await apply(140, "undo");
    expect(await shape()).toEqual(before);

    // The redo is the very schema the first run made, and — as its file says —
    // starts everybody off, the choice made before the undo gone with it.
    await apply(140, "do");
    expect(await shape()).toEqual(after);
    expect([...(await switches()).values()]).toEqual([false, false, false]);
    await db`update users set dates_between_days = true where id = ${early}`;
    expect((await switches()).get(early)).toBe(true);
  },
  slow,
);

test(
  "150 frame-hidden-and-place: frames start visible, a replay keeps what the owner set, an undo takes the trigger with the columns, a redo brings its rule back",
  async () => {
    const { db, apply, shape } = await chain(150);
    const before = await shape();
    const { photo } = await seed(db);
    const early = await photo();

    await apply(150, "do");
    const after = await shape();
    expect(after).not.toEqual(before);
    const frame = async () => {
      const [row] = await db<{ hidden: boolean; latitude: number | null }[]>`
        select hidden, latitude from media_items where id = ${early}
      `;
      return row;
    };
    expect(await frame()).toEqual({ hidden: false, latitude: null });

    // The owner hides it and sets the place; the worker writes the camera's over it.
    const placed = async () => {
      await db`
        update media_items set hidden = true, latitude = 59.94, longitude = 30.31,
          place_edited_at = clock_timestamp()
        where id = ${early}
      `;
      await db`update media_items set latitude = 55.5, longitude = 37.5 where id = ${early}`;
      return frame();
    };
    expect(await placed()).toEqual({ hidden: true, latitude: 59.94 });

    // The replay: same schema, same values, and one trigger rather than two.
    await apply(150, "do");
    expect(await shape()).toEqual(after);
    expect(await frame()).toEqual({ hidden: true, latitude: 59.94 });
    const triggers = async () => {
      const [row] = await db<{ n: number }[]>`
        select count(*)::int as n from pg_trigger where tgname = 'media_items_keep_hand_placed'
      `;
      return row?.n;
    };
    expect(await triggers()).toBe(1);

    // The undo: the schema as before, no trigger left to hold a column that is
    // gone, the frame itself kept — and twice over, as a redo script would.
    await apply(150, "undo");
    expect(await shape()).toEqual(before);
    expect(await triggers()).toBe(0);
    await apply(150, "undo");
    expect(await shape()).toEqual(before);
    await db`update media_items set latitude = 55.5 where id = ${early}`;

    // The redo: the same schema, everything visible again, and the rule works.
    await apply(150, "do");
    expect(await shape()).toEqual(after);
    expect(await frame()).toEqual({ hidden: false, latitude: 55.5 });
    expect(await placed()).toEqual({ hidden: true, latitude: 59.94 });
  },
  slow,
);
