import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../src/integrations/db/index.ts";
import { deleteObjects, putObject, storageConfigured } from "../src/integrations/storage/s3.ts";

type SeedUser = {
  email: string;
  username: string;
  name: string;
  language: "ru" | "en";
  storageBytes: number;
  tokens: number;
};

type SeedLabel = {
  name: string;
  color: string;
  shared: boolean;
  owner?: string;
};

type SeedPhoto = {
  file: string;
  daysAgo: number;
  description: string;
  camera: string | null;
  place: { latitude: number; longitude: number } | null;
  labels: string[];
  by?: string;
};

type SeedMember = {
  username: string;
  role: "admin" | "contributor" | "viewer";
  contribution: "not_started" | "more_coming" | "done";
};

type SeedProject = {
  title: string;
  owner: string;
  eventStart: Date;
  eventEnd: Date | null;
  storageBytes: number;
  members: SeedMember[];
  labels: SeedLabel[];
  photos: SeedPhoto[];
};

const day = 86_400_000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * day);
const gb = (count: number): number => count * 1024 ** 3;
const PHOTO_WIDTH = 1080;
const PHOTO_HEIGHT = 1440;

const users: SeedUser[] = [
  {
    email: "a@x.io",
    username: "alice",
    name: "Алиса",
    language: "ru",
    storageBytes: gb(100),
    tokens: 10,
  },
  {
    email: "b@x.io",
    username: "bob",
    name: "Bob",
    language: "en",
    storageBytes: gb(50),
    tokens: 5,
  },
  {
    email: "c@x.io",
    username: "carol",
    name: "Кэрол",
    language: "ru",
    storageBytes: gb(20),
    tokens: 0,
  },
  { email: "d@x.io", username: "dave", name: "Dave", language: "en", storageBytes: 0, tokens: 0 },
];

const projects: SeedProject[] = [
  {
    title: "Свадьба",
    owner: "alice",
    eventStart: daysAgo(20),
    eventEnd: daysAgo(19),
    storageBytes: gb(100),
    members: [
      { username: "bob", role: "contributor", contribution: "done" },
      { username: "carol", role: "viewer", contribution: "more_coming" },
    ],
    labels: [
      { name: "Обложка", color: "#e8b04b", shared: true },
      { name: "Море", color: "#3b82f6", shared: true },
      { name: "Любимое", color: "#ec4899", shared: false, owner: "alice" },
    ],
    photos: [
      {
        file: "party.jpg",
        daysAgo: 20,
        description: "Первый танец",
        camera: "iPhone 15 Pro",
        place: { latitude: 55.75, longitude: 37.61 },
        labels: ["Обложка", "Море"],
      },
      {
        file: "wedding.jpg",
        daysAgo: 20,
        description: "Церемония",
        camera: "iPhone 15 Pro",
        place: null,
        labels: ["Обложка"],
        by: "bob",
      },
      {
        file: "dance.jpg",
        daysAgo: 19,
        description: "Танцы",
        camera: null,
        place: null,
        labels: ["Любимое"],
        by: "carol",
      },
      {
        file: "birthday.jpg",
        daysAgo: 19,
        description: "Гости",
        camera: "iPhone 15 Pro",
        place: { latitude: 55.76, longitude: 37.62 },
        labels: [],
      },
    ],
  },
  {
    title: "Дача",
    owner: "bob",
    eventStart: daysAgo(7),
    eventEnd: daysAgo(6),
    storageBytes: gb(50),
    members: [{ username: "alice", role: "contributor", contribution: "more_coming" }],
    labels: [{ name: "Обложка", color: "#84cc16", shared: true }],
    photos: [
      {
        file: "picnic.jpg",
        daysAgo: 7,
        description: "Пикник",
        camera: "Pixel",
        place: null,
        labels: ["Обложка"],
      },
      { file: "sea.jpg", daysAgo: 7, description: "Река", camera: null, place: null, labels: [] },
      {
        file: "friends.jpg",
        daysAgo: 6,
        description: "Друзья",
        camera: null,
        place: { latitude: 56.1, longitude: 37.2 },
        labels: [],
        by: "alice",
      },
    ],
  },
  {
    title: "Концерт",
    owner: "carol",
    eventStart: daysAgo(2),
    eventEnd: null,
    storageBytes: gb(20),
    members: [],
    labels: [{ name: "Обложка", color: "#a855f7", shared: true }],
    photos: [
      {
        file: "dance.jpg",
        daysAgo: 2,
        description: "Сцена",
        camera: null,
        place: null,
        labels: ["Обложка"],
      },
      { file: "city.jpg", daysAgo: 2, description: "Город", camera: null, place: null, labels: [] },
    ],
  },
];

async function main(): Promise<void> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from users`;
  if ((rows[0]?.count ?? 0) > 0) {
    console.log("seed: users already exist, skipping");
    return;
  }
  if (!storageConfigured()) throw new Error("seed: S3 is not configured");

  const keys: string[] = [];
  try {
    await sql.begin(async (tx) => {
      const ids = new Map<string, string>();
      for (const user of users) {
        const id = randomUUID();
        ids.set(user.username, id);
        await tx`
          insert into users (id, email, username, name, language, registered, storage_bytes, tokens)
          values (${id}, ${user.email}, ${user.username}, ${user.name}, ${user.language}, true, ${user.storageBytes}, ${user.tokens})
        `;
        await tx`
          insert into auth_identities (provider, provider_account_id, user_id)
          values ('email', ${user.email}, ${id})
        `;
      }
      const idOf = (username: string): string => {
        const id = ids.get(username);
        if (!id) throw new Error(`seed: unknown user ${username}`);
        return id;
      };

      for (const [owner, contact] of [
        ["alice", "bob"],
        ["alice", "carol"],
        ["bob", "alice"],
        ["carol", "alice"],
        ["dave", "alice"],
      ] as const) {
        await tx`
          insert into contacts (owner_id, contact_id) values (${idOf(owner)}, ${idOf(contact)})
          on conflict do nothing
        `;
      }

      for (const project of projects) {
        const projectId = randomUUID();
        await tx`
          insert into projects (id, title, event_start, event_end, storage_bytes)
          values (${projectId}, ${project.title}, ${project.eventStart}, ${project.eventEnd}, ${project.storageBytes})
        `;
        await tx`
          insert into project_members (project_id, user_id, role, contribution, storage_bytes)
          values (${projectId}, ${idOf(project.owner)}, 'admin', 'done', ${project.storageBytes})
        `;
        for (const member of project.members) {
          await tx`
            insert into project_members (project_id, user_id, role, contribution, storage_bytes)
            values (${projectId}, ${idOf(member.username)}, ${member.role}, ${member.contribution}, 0)
          `;
        }

        const labelIds = new Map<string, string>();
        for (const label of project.labels) {
          const id = randomUUID();
          labelIds.set(label.name, id);
          await tx`
            insert into labels (id, project_id, owner_id, name, color_hex, shared)
            values (${id}, ${projectId}, ${idOf(label.owner ?? project.owner)}, ${label.name}, ${label.color}, ${label.shared})
          `;
        }

        for (const photo of project.photos) {
          const mediaId = randomUUID();
          const file = readFileSync(new URL(`./seed-assets/${photo.file}`, import.meta.url));
          const key = `remember/jpg/${mediaId}`;
          await putObject(key, file, "image/jpeg");
          keys.push(key);
          const uploader = photo.by ?? project.owner;
          await tx`
            insert into media_items (
              id, kind, storage_key, uploaded_by, format, bytes, width, height,
              captured_at, camera_model, latitude, longitude
            )
            values (
              ${mediaId}, 'photo', ${key}, ${idOf(uploader)}, 'jpeg', ${file.length},
              ${PHOTO_WIDTH}, ${PHOTO_HEIGHT}, ${daysAgo(photo.daysAgo)}, ${photo.camera},
              ${photo.place?.latitude ?? null}, ${photo.place?.longitude ?? null}
            )
          `;
          const itemId = randomUUID();
          await tx`
            insert into project_items (id, project_id, media_id, kind, description)
            values (${itemId}, ${projectId}, ${mediaId}, 'photo', ${photo.description})
          `;
          for (const name of photo.labels) {
            const labelId = labelIds.get(name);
            if (!labelId) throw new Error(`seed: unknown label ${name}`);
            await tx`
              insert into project_item_labels (project_item_id, label_id)
              values (${itemId}, ${labelId}) on conflict do nothing
            `;
          }
          await tx`update projects set storage_spend = storage_spend + ${file.length} where id = ${projectId}`;
          await tx`
            update project_members set storage_spend = storage_spend + ${file.length}
            where project_id = ${projectId} and user_id = ${idOf(uploader)}
          `;
          await tx`update users set storage_spend = storage_spend + ${file.length} where id = ${idOf(uploader)}`;
        }
      }
    });
  } catch (error) {
    if (keys.length > 0) await deleteObjects(keys).catch(() => undefined);
    throw error;
  }
  console.log(`seed: ${users.length} users, ${projects.length} projects`);
}

main()
  .catch((error) => {
    console.error("seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
