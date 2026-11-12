import { ANTHROPOVY } from "./anthropovy/index.ts";
import { seedAnthropovy } from "./anthropovy/seed.ts";
import { API, type Project, type Token, tokenOf } from "./common.ts";
import { seedContacts } from "./contacts/index.ts";
import { seedMontages } from "./montages.ts";
import { createProject, PROJECT_ASSETS, PROJECTS, removeSeedProject } from "./projects/index.ts";
import { seedMedia } from "./upload.ts";
import { seedUsers } from "./users/index.ts";

async function seedProject(
  tokens: Map<string, Token>,
  project: Project,
  assetsDir: string,
): Promise<void> {
  const owner = tokenOf(tokens, project.owner);
  await removeSeedProject(owner, project.title);
  const { projectId, labelIds } = await createProject(tokens, project);
  const media = await seedMedia(tokens, project, projectId, labelIds, assetsDir);
  await seedMontages(owner, project, projectId, media.itemIds);
  console.log(
    `test seed: «${project.title}» — ${project.assets.length} assets, ${project.montages.length} montages`,
  );
}

async function main(): Promise<void> {
  const tokens = await seedUsers();
  await seedContacts(tokens);

  for (const project of PROJECTS) await seedProject(tokens, project, PROJECT_ASSETS);
  await seedAnthropovy(ANTHROPOVY.owner);

  console.log(`test seed: done against ${API}`);
}

main().catch((error) => {
  console.error("test seed failed:", error);
  process.exitCode = 1;
});
