import { API, tokenOf } from "./common.ts";
import { seedContacts } from "./contacts.ts";
import { seedMedia } from "./media.ts";
import { seedMontages } from "./montages.ts";
import { createProject, PROJECTS, removeSeedProject } from "./projects.ts";
import { seedUsers } from "./users.ts";

async function main(): Promise<void> {
  const tokens = await seedUsers();
  await seedContacts(tokens);

  for (const project of PROJECTS) {
    const owner = tokenOf(tokens, project.owner);
    await removeSeedProject(owner, project.title);
    const { projectId, labelIds } = await createProject(tokens, project);
    const itemIds = await seedMedia(tokens, project, projectId, labelIds);
    await seedMontages(owner, project, projectId, itemIds);
    console.log(
      `test seed: «${project.title}» — ${project.assets.length} assets, ${project.montages.length} montages`,
    );
  }

  console.log(`test seed: done against ${API}`);
}

main().catch((error) => {
  console.error("test seed failed:", error);
  process.exitCode = 1;
});
