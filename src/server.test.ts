import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { expect, test } from "vitest";

/**
 * The real entrypoint, `node src/server.ts`, as a process: the order it checks
 * things in (storage settings, then the database, then listening) and that a
 * bad setting is a loud exit rather than a server that answers 503 forever.
 * The environment is built from nothing, so a local `.env` cannot leak in.
 */

const database = process.env.DATABASE_URL ?? "";
const unreachable = "postgres://remember:remember@127.0.0.1:1/remember";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const google = {
  STORAGE_DRIVER: "google",
  GOOGLE_STORAGE_CREDENTIALS: JSON.stringify({
    client_email: "fake@fake-project.iam.gserviceaccount.com",
    private_key: privateKey,
  }),
  GOOGLE_STORAGE_BUCKET: "fake-bucket",
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

function boot(env: Record<string, string>, port: number) {
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk;
    });
  }
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { child, exited, output: () => output };
}

/** A start that is expected to end on its own. */
const dies = async (env: Record<string, string>) => {
  const run = boot(env, await freePort());
  const code = await run.exited;
  return { code, output: run.output() };
};

test("no database URL, or a database that does not answer: the server exits with the reason", async () => {
  const noUrl = await dies({});
  expect(noUrl.code).toBe(1);
  expect(noUrl.output).toContain("DATABASE_URL is not set");

  const down = await dies({ DATABASE_URL: unreachable });
  expect(down.code).toBe(1);
  expect(down.output).toContain("ECONNREFUSED");
});

test("google storage without its prefix stops the server; with key and prefix it gets on to the database check", async () => {
  const noPrefix = await dies({ DATABASE_URL: database, ...google });
  expect(noPrefix.code).toBe(1);
  expect(noPrefix.output).toContain("GOOGLE_STORAGE_PREFIX is not set");

  // Storage settings are checked before the database: with a good key and a
  // prefix the failure left is the unreachable database, and the key itself is
  // never printed.
  const noDb = await dies({
    DATABASE_URL: unreachable,
    GOOGLE_STORAGE_PREFIX: "fake/prefix",
    ...google,
  });
  expect(noDb.code).toBe(1);
  expect(noDb.output).toContain("ECONNREFUSED");
  expect(noDb.output).not.toContain("PRIVATE KEY");
});

test("a configured server listens, and its public pages need no sign-in", async () => {
  const port = await freePort();
  const run = boot({ DATABASE_URL: database, NODE_ENV: "production" }, port);
  const url = `http://127.0.0.1:${port}`;
  const answers = () =>
    fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    );
  try {
    // Up when /health answers; a process that died first is reported with its output.
    const up = await Promise.race([
      run.exited.then((code) => `exited ${code}: ${run.output()}`),
      (async () => {
        for (let i = 0; i < 100; i++) {
          if (await answers()) return "up";
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return "never came up";
      })(),
    ]);
    expect(up).toBe("up");

    expect(await (await fetch(`${url}/health`)).text()).toBe('{"status":"ok"}');
    expect(await (await fetch(`${url}/auth/methods`)).json()).toEqual({
      email: true,
      apple: false,
      google: false,
    });
    const privacy = await fetch(`${url}/privacy`);
    expect(privacy.status).toBe(200);
    const page = await privacy.text();
    expect(page).toContain('lang="ru"');
    expect(page).toContain('lang="en"');
    expect((await fetch(`${url}/memories`)).status).toBe(401);
  } finally {
    run.child.kill("SIGTERM");
    await run.exited;
  }
});
