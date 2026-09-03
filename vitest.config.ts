import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests live in `src/` and nowhere else. Spelled out because the default
  // pattern sweeps the whole tree: a git worktree under `.claude/worktrees/`
  // holds a second copy of every test file, and running both copies at once
  // means two suites writing the same rows in the same database.
  test: { include: ["src/**/*.test.ts"] },
});
