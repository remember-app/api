import { spawnSync } from "node:child_process";

const run = (script: string): void => {
  const result = spawnSync(process.execPath, [script], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`deploy-worker: ${script} failed with ${result.status ?? "no status"}`);
    process.exit(result.status ?? 1);
  }
};

run("scripts/migrate.ts");
run("scripts/seed.ts");
