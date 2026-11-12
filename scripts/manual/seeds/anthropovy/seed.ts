import { sql } from "../../../../src/integrations/db/index.ts";
import { del, login, type Project, type Token } from "../common.ts";
import { createProject } from "../projects/index.ts";
import { seedMedia } from "../upload.ts";
import { applySnapshot, clearTrail } from "./apply.ts";
import { ANTHROPOVY, ANTHROPOVY_ASSETS } from "./index.ts";

async function emailOf(username: string): Promise<string> {
  const [user] = await sql<{ email: string }[]>`
    select email from users where username = ${username}
  `;
  if (!user) throw new Error(`test seed: no user with nickname ${username}`);
  return user.email;
}

async function removeByTitle(title: string): Promise<void> {
  const owners = await sql<{ id: string; email: string }[]>`
    select distinct on (p.id) p.id, u.email
    from projects p
    join project_members pm on pm.project_id = p.id and pm.role = 'admin'
    join users u on u.id = pm.user_id
    where p.title = ${title}
    order by p.id
  `;
  for (const owner of owners) {
    const session = await login(owner.email);
    await del(`/v1/projects/${owner.id}`, session.token);
  }
}

export async function seedAnthropovy(username: string): Promise<void> {
  const email = await emailOf(username);
  const project: Project = { ...ANTHROPOVY, owner: username };

  await clearTrail(project.title);
  await removeByTitle(project.title);

  const session = await login(email);
  const tokens = new Map<string, Token>([[username, session.token]]);
  const { projectId, labelIds } = await createProject(tokens, project);
  const media = await seedMedia(tokens, project, projectId, labelIds, ANTHROPOVY_ASSETS);
  await applySnapshot(projectId, media.byFile);

  console.log(
    `test seed: «${project.title}» for ${username} — ${project.assets.length} assets, analysis and montage from the snapshot`,
  );
}
