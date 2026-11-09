import { readFileSync } from "node:fs";

const API = (process.env.API_URL ?? "http://localhost:3000").replace(/\/+$/, "");

type Answer<T> = T & { error?: string };
type Token = string;

const day = 86_400_000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * day);
const gb = (count: number): number => count * 1024 ** 3;

async function call<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  token?: Token,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => null)) as Answer<T> | null;
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(answer)}`);
  }
  if (answer === null) throw new Error(`${method} ${path} → empty answer`);
  return answer;
}

const get = <T>(path: string, token: Token) => call<T>(path, "GET", token);
const post = <T>(path: string, token: Token | undefined, body?: unknown) =>
  call<T>(path, "POST", token, body);
const patch = <T>(path: string, token: Token, body: unknown) => call<T>(path, "PATCH", token, body);

type Session = { token: Token; user: { id: string; registered: boolean } };

async function login(email: string): Promise<Session> {
  const started = await post<{ code?: string }>("/v1/auth/email/start", undefined, { email });
  if (!started.code) {
    throw new Error(
      "test seed needs the dev login door: start the API with EMAIL_LOGIN_DEV_BYPASS=123456",
    );
  }
  return post<Session>("/v1/auth/email/verify", undefined, { email, code: started.code });
}

type Person = {
  email: string;
  username: string;
  name: string;
  language: "ru" | "en";
};

const people: Person[] = [
  { email: "a@x.io", username: "alice", name: "Алиса", language: "ru" },
  { email: "b@x.io", username: "bob", name: "Bob", language: "en" },
  { email: "c@x.io", username: "carol", name: "Кэрол", language: "ru" },
  { email: "d@x.io", username: "dave", name: "Dave", language: "en" },
];

type Photo = {
  file: string;
  daysAgo: number;
  description: string;
  place: { latitude: number; longitude: number } | null;
  labels: string[];
  by?: string;
};

type Project = {
  title: string;
  owner: string;
  eventStart: Date;
  eventEnd: Date | null;
  members: { username: string; role: "admin" | "contributor" | "viewer"; contribution: string }[];
  labels: { name: string; colorHex: string; shared: boolean; owner?: string }[];
  photos: Photo[];
};

const projects: Project[] = [
  {
    title: "Свадьба",
    owner: "alice",
    eventStart: daysAgo(20),
    eventEnd: daysAgo(19),
    members: [
      { username: "bob", role: "contributor", contribution: "done" },
      { username: "carol", role: "contributor", contribution: "more_coming" },
      { username: "dave", role: "viewer", contribution: "not_started" },
    ],
    labels: [
      { name: "Обложка", colorHex: "#e8b04b", shared: true },
      { name: "Море", colorHex: "#3b82f6", shared: true },
      { name: "Любимое", colorHex: "#ec4899", shared: false, owner: "alice" },
    ],
    photos: [
      {
        file: "party.jpg",
        daysAgo: 20,
        description: "Первый танец",
        place: { latitude: 55.75, longitude: 37.61 },
        labels: ["Обложка", "Море"],
      },
      {
        file: "wedding.jpg",
        daysAgo: 20,
        description: "Церемония",
        place: null,
        labels: ["Обложка"],
        by: "bob",
      },
      {
        file: "dance.jpg",
        daysAgo: 19,
        description: "Танцы",
        place: null,
        labels: [],
        by: "carol",
      },
      {
        file: "birthday.jpg",
        daysAgo: 19,
        description: "Гости",
        place: { latitude: 55.76, longitude: 37.62 },
        labels: ["Любимое"],
      },
    ],
  },
  {
    title: "Дача",
    owner: "bob",
    eventStart: daysAgo(7),
    eventEnd: daysAgo(6),
    members: [{ username: "alice", role: "contributor", contribution: "more_coming" }],
    labels: [{ name: "Обложка", colorHex: "#84cc16", shared: true }],
    photos: [
      {
        file: "picnic.jpg",
        daysAgo: 7,
        description: "Пикник",
        place: null,
        labels: ["Обложка"],
      },
      { file: "sea.jpg", daysAgo: 7, description: "Река", place: null, labels: [] },
      {
        file: "friends.jpg",
        daysAgo: 6,
        description: "Друзья",
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
    members: [],
    labels: [{ name: "Обложка", colorHex: "#a855f7", shared: true }],
    photos: [
      { file: "dance.jpg", daysAgo: 2, description: "Сцена", place: null, labels: ["Обложка"] },
      { file: "city.jpg", daysAgo: 2, description: "Город", place: null, labels: [] },
    ],
  },
];

type UploadPlan = { id: string; parts: string[] };

async function uploadPhoto(
  token: Token,
  projectId: string,
  photo: Photo,
): Promise<{ itemId: string; mediaId: string }> {
  const file = readFileSync(new URL(`./test-assets/${photo.file}`, import.meta.url));
  const plan = await post<UploadPlan>(`/v1/projects/${projectId}/uploads`, token, {
    kind: "photo",
    sizeBytes: file.length,
    fileName: photo.file,
    capturedAt: daysAgo(photo.daysAgo).toISOString(),
  });
  const url = plan.parts[0];
  if (plan.parts.length !== 1 || !url) {
    throw new Error(`test seed expects one part for ${photo.file}, got ${plan.parts.length}`);
  }
  const put = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: file,
  });
  if (!put.ok) throw new Error(`S3 PUT ${photo.file} → ${put.status} ${await put.text()}`);
  const etag = (put.headers.get("etag") ?? "").replaceAll('"', "");
  if (!etag) throw new Error(`S3 PUT ${photo.file} → no ETag`);
  return post<{ itemId: string; mediaId: string }>(
    `/v1/projects/${projectId}/uploads/${plan.id}/complete`,
    token,
    { parts: [{ part_number: 1, etag }] },
  );
}

async function main(): Promise<void> {
  const firstPerson = people[0];
  if (!firstPerson) throw new Error("test seed: no people configured");
  const tokens = new Map<string, Token>();
  const first = await login(firstPerson.email);
  const me = await get<{ registered: boolean }>("/v1/me", first.token);
  if (me.registered) {
    console.log("test seed: data already exists — run `make fresh` to rebuild it");
    return;
  }
  for (const person of people) {
    const session = person.email === firstPerson.email ? first : await login(person.email);
    tokens.set(person.username, session.token);
    await post("/v1/me/username", session.token, { username: person.username });
    await post("/v1/me/name", session.token, { name: person.name });
    await post("/v1/me/language", session.token, { language: person.language });
  }
  const tokenOf = (username: string): Token => {
    const token = tokens.get(username);
    if (!token) throw new Error(`test seed: unknown user ${username}`);
    return token;
  };

  const chain = [
    ["alice", "bob"],
    ["bob", "carol"],
    ["carol", "dave"],
    ["dave", "alice"],
  ] as const;
  for (const [sender, invitee] of chain) {
    const invite = await post<{ token: string }>("/v1/invites/app", tokenOf(sender), {});
    await post("/v1/invites/accept", tokenOf(invitee), { token: invite.token });
  }

  for (const project of projects) {
    const owner = tokenOf(project.owner);
    const created = await post<{ id: string }>("/v1/projects", owner, {
      title: project.title,
      eventStart: project.eventStart.toISOString(),
      eventEnd: project.eventEnd?.toISOString() ?? null,
      storageBytes: gb(1),
    });
    const projectId = created.id;

    for (const member of project.members) {
      await post(`/v1/projects/${projectId}/members`, owner, {
        username: member.username,
        role: member.role,
      });
      if (member.role !== "viewer") {
        await post(`/v1/projects/${projectId}/contribution`, tokenOf(member.username), {
          status: member.contribution,
        });
      }
    }
    await post(`/v1/projects/${projectId}/contribution`, owner, { status: "done" });

    const labels = new Map<string, string>();
    for (const label of project.labels) {
      const made = await post<{ id: string }>(
        `/v1/projects/${projectId}/labels`,
        tokenOf(label.owner ?? project.owner),
        { name: label.name, colorHex: label.colorHex, shared: label.shared },
      );
      labels.set(label.name, made.id);
    }

    for (const photo of project.photos) {
      const uploader = photo.by ?? project.owner;
      const uploaded = await uploadPhoto(tokenOf(uploader), projectId, photo);
      await patch(`/v1/projects/${projectId}/items/${uploaded.itemId}`, tokenOf(uploader), {
        description: photo.description,
      });
      if (photo.place) {
        await patch(`/v1/projects/${projectId}/media/${uploaded.mediaId}`, tokenOf(uploader), {
          latitude: photo.place.latitude,
          longitude: photo.place.longitude,
        });
      }
      for (const name of photo.labels) {
        const labelId = labels.get(name);
        if (!labelId) throw new Error(`test seed: unknown label ${name}`);
        await post(`/v1/projects/${projectId}/labels/${labelId}/items`, owner, {
          itemIds: [uploaded.itemId],
        });
      }
    }
    console.log(`test seed: «${project.title}» — ${project.photos.length} photos`);
  }
  console.log(`test seed: done against ${API}`);
}

main().catch((error) => {
  console.error("test seed failed:", error);
  process.exitCode = 1;
});
