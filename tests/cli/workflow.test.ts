import "../../scripts/lib/privacy.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify, stripVTControlCharacters } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "node_modules/cf/bin/cf");

async function prepareProject(project: string) {
  await symlink(join(root, "node_modules"), join(project, "node_modules"), "dir");
  await cp(join(root, "src"), join(project, "src"), { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) await cp(join(root, file), join(project, file));
  await writeFile(
    join(project, "cloudflare.config.ts"),
    `export { default } from ${JSON.stringify(join(root, "cloudflare.config.ts"))};\n`,
  );
  await writeFile(
    join(project, "vite.config.ts"),
    `import config from ${JSON.stringify(join(root, "vite.config.ts"))};\nexport default { ...config, publicDir: ${JSON.stringify(join(root, "dist"))}, server: { host: "127.0.0.1", port: 0 } };\n`,
  );
}

test("local migrations and demo data are visible to cf dev in isolated storage", async () => {
  const project = await mkdtemp(join(tmpdir(), "kuakua-cf-"));
  const env = {
    ...process.env,
    CI: "true",
    // Exercise Vite's colored CI output, including escape codes between the host and port.
    FORCE_COLOR: "1",
    NO_COLOR: undefined,
    WRANGLER_SEND_METRICS: "false",
    ENV_FILE: join(project, "missing.env"),
    CLOUDFLARE_REGISTRY_PATH: join(project, "registry"),
  };
  let server: ReturnType<typeof spawn> | undefined;
  let logs = "";
  try {
    await prepareProject(project);
    const state = join(project, ".wrangler/state");
    await exec(process.execPath, [join(root, "scripts/seed-demo.ts"), `--persist-to=${state}`], { cwd: root, env });
    const avatar = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const avatarFile = join(project, "avatar.png");
    await writeFile(avatarFile, avatar);
    await exec(
      process.execPath,
      [
        cli,
        "r2",
        "objects",
        "put",
        "probe.png",
        "--bucket-name",
        "kuakua-files",
        "--file",
        avatarFile,
        "--content-type",
        "image/png",
        "--local",
        "--persist-to",
        state,
      ],
      { cwd: project, env },
    );
    await exec(
      process.execPath,
      [
        cli,
        "d1",
        "raw",
        "local-dev",
        "--local",
        "--persist-to",
        state,
        "--sql",
        "UPDATE users SET custom_avatar_key = 'probe.png' WHERE email = 'mushan@example.com'",
      ],
      { cwd: project, env },
    );
    server = spawn(process.execPath, [cli, "dev", "--mode", "development"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(new Error(`cf dev did not start:\n${logs}`)), 15_000);
      const collect = (data: Buffer) => {
        logs += data.toString();
        const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(stripVTControlCharacters(logs));
        if (match?.[1]) {
          clearTimeout(timeout);
          resolveUrl(match[1]);
        }
      };
      server?.stdout?.on("data", collect);
      server?.stderr?.on("data", collect);
      server?.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`cf dev exited (${code}):\n${logs}`));
      });
    });
    const me = await fetch(`${url}/api/me`);
    assert.equal(me.status, 200, await me.clone().text());
    const profile = (await me.json()) as { email: string; user: { id: number; name: string } };
    assert.equal(profile.email, "mushan@example.com");
    assert.equal(profile.user.name, "Mushan Yang");
    const servedAvatar = await fetch(`${url}/avatars/${profile.user.id}`);
    assert.equal(servedAvatar.status, 200);
    assert.deepEqual(Buffer.from(await servedAvatar.arrayBuffer()), avatar);
    const page = await fetch(`${url}/u/me`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /<div id="root"><\/div>/);
    await exec(process.execPath, [cli, "build", "--mode", "development"], { cwd: project, env });
    for (const extra of [[], ["--prebuilt"]]) {
      await exec(process.execPath, [cli, "deploy", "--mode", "development", "--dry-run", "--no-provision", ...extra], {
        cwd: project,
        env,
      });
    }
    await assert.rejects(
      exec(process.execPath, [cli, "deploy", "--mode", "production", "--prebuilt", "--dry-run"], { cwd: project, env }),
      /mode/i,
    );
  } finally {
    if (server && server.exitCode === null) {
      const closed = once(server, "exit");
      server.kill("SIGTERM");
      await closed;
    }
    await mkdir(join(root, "test-results"), { recursive: true });
    await writeFile(join(root, "test-results/cf-dev.log"), logs);
    await rm(project, { recursive: true, force: true });
  }
});

test("production cf build and deploy dry-run use existing bindings without exposing secrets", async () => {
  const project = await mkdtemp(join(tmpdir(), "kuakua-cf-production-"));
  const envFile = join(project, "production.env");
  const secret = "test-secret-not-for-build-output";
  const env = {
    ...process.env,
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    ENV_FILE: envFile,
    CLOUDFLARE_REGISTRY_PATH: join(project, "registry"),
  };
  try {
    await prepareProject(project);
    await writeFile(
      envFile,
      `WORKER_NAME=example-kudos
PUBLIC_URL=https://kudos.example.com
D1_DATABASE_ID=00000000-0000-4000-8000-000000000001
EMAIL_NOTIFY=0
LARK_APP_SECRET=${secret}
`,
      { mode: 0o600 },
    );
    await exec(process.execPath, [cli, "build", "--mode", "production"], { cwd: project, env });
    const config = await readFile(join(project, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8");
    assert.equal(config.includes(secret), false);
    assert.equal(config.includes("DEV_AUTH_EMAIL"), false);
    assert.match(config, /example-kudos/);
    assert.match(config, /00000000-0000-4000-8000-000000000001/);
    const secretsFile = join(project, "secrets.json");
    await writeFile(secretsFile, JSON.stringify({ LARK_APP_SECRET: secret }), { mode: 0o600 });
    await exec(process.execPath, [cli, "deploy", "--mode", "production", "--dry-run", "--no-provision", "--secrets-file", secretsFile], {
      cwd: project,
      env,
    });
    await exec(
      process.execPath,
      [cli, "deploy", "--mode", "production", "--prebuilt", "--dry-run", "--no-provision", "--secrets-file", secretsFile],
      { cwd: project, env },
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
