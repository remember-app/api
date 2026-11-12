import { daysAgo, del, gb, get, type Project, post, type Token, tokenOf } from "./common.ts";

export const PROJECTS: Project[] = [
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
    assets: [
      {
        file: "party.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 20,
        description: "Первый танец",
        place: { latitude: 55.75, longitude: 37.61 },
        labels: ["Обложка", "Море"],
      },
      {
        file: "wedding.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 20,
        description: "Церемония",
        place: null,
        labels: ["Обложка"],
        by: "bob",
      },
      {
        file: "dance.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 19,
        description: "Танцы",
        place: null,
        labels: [],
        by: "carol",
      },
      {
        file: "birthday.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 19,
        description: "Гости",
        place: { latitude: 55.76, longitude: 37.62 },
        labels: ["Любимое"],
      },
      {
        file: "song.m4a",
        kind: "audio",
        contentType: "audio/mp4",
        durationSeconds: 8,
        daysAgo: 19,
        description: "Первый танец, музыка",
        place: null,
        labels: [],
      },
    ],
    montages: [
      {
        targetSeconds: 30,
        prompt: "Тёплый фильм о первом танце и гостях",
        dimensions: { width: 1080, height: 1920 },
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
    assets: [
      {
        file: "picnic.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 7,
        description: "Пикник",
        place: null,
        labels: ["Обложка"],
      },
      {
        file: "sea.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 7,
        description: "Река",
        place: null,
        labels: [],
      },
      {
        file: "friends.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 6,
        description: "Друзья",
        place: { latitude: 56.1, longitude: 37.2 },
        labels: [],
        by: "alice",
      },
      {
        file: "sea.mp4",
        kind: "video",
        contentType: "video/mp4",
        durationSeconds: 5,
        daysAgo: 6,
        description: "Волны на реке",
        place: null,
        labels: [],
      },
    ],
    montages: [
      {
        targetSeconds: 20,
        prompt: null,
        dimensions: { width: 1080, height: 1920 },
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
    assets: [
      {
        file: "dance.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 2,
        description: "Сцена",
        place: null,
        labels: ["Обложка"],
      },
      {
        file: "city.jpg",
        kind: "photo",
        contentType: "image/jpeg",
        daysAgo: 2,
        description: "Город",
        place: null,
        labels: [],
      },
    ],
    montages: [],
  },
];

type ProjectCard = { id: string; title: string; myRole: "admin" | "contributor" | "viewer" };

export async function removeSeedProject(token: Token, title: string): Promise<void> {
  const page = await get<{ items: ProjectCard[] }>("/v1/projects?limit=200", token);
  for (const card of page.items) {
    if (card.title !== title || card.myRole !== "admin") continue;
    await del(`/v1/projects/${card.id}`, token);
    console.log(`test seed: removed existing «${title}»`);
  }
}

export async function createProject(
  tokens: Map<string, Token>,
  project: Project,
): Promise<{ projectId: string; labelIds: Map<string, string> }> {
  const owner = tokenOf(tokens, project.owner);
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
      await post(`/v1/projects/${projectId}/contribution`, tokenOf(tokens, member.username), {
        status: member.contribution,
      });
    }
  }
  await post(`/v1/projects/${projectId}/contribution`, owner, { status: "done" });

  const labelIds = new Map<string, string>();
  for (const label of project.labels) {
    const made = await post<{ id: string }>(
      `/v1/projects/${projectId}/labels`,
      tokenOf(tokens, label.owner ?? project.owner),
      { name: label.name, colorHex: label.colorHex, shared: label.shared },
    );
    labelIds.set(label.name, made.id);
  }

  return { projectId, labelIds };
}
