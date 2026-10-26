import "../../scripts/lib/privacy.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

test("setup uses cf against a local API fixture, preserves resource IDs and leaves foreign Access policies alone", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const dir = await mkdtemp(join(tmpdir(), "kuakua-setup-"));
  const account = "00000000000000000000000000000001";
  const zone = "00000000000000000000000000000002";
  const db = "00000000-0000-4000-8000-000000000001";
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let created = false;
  let foreignPolicy = false;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer fixture-token");
      const url = new URL(request.url ?? "", "http://fixture");
      const path = url.pathname.replace(`/accounts/${account}`, "").replace(`/zones/${zone}`, "");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
      let result: unknown;
      if (request.method !== "GET") writes.push({ path, body });
      switch (path) {
        case "/access/organizations":
          result = { auth_domain: "example.cloudflareaccess.com" };
          break;
        case "/d1/database":
          result = request.method === "GET" ? (created ? [{ name: "example-kudos", uuid: db }] : []) : { uuid: db };
          break;
        case "/r2/buckets":
          result = { buckets: created ? [{ name: "example-kudos-files" }] : [] };
          break;
        case "/access/policies":
          result = request.method === "GET" ? (created ? [{ name: "kuakua: kudos.example.com", id: "policy" }] : []) : { id: "policy" };
          break;
        case "/access/policies/policy":
          result = { id: "policy" };
          break;
        case "/access/identity_providers":
          result = [{ id: "idp" }];
          break;
        case "/access/apps": {
          const app = {
            id: "app",
            aud: "a".repeat(64),
            domain: "kudos.example.com",
            policies: [{ id: foreignPolicy ? "foreign" : "policy" }],
          };
          result = request.method === "GET" ? (created ? [app] : []) : app;
          break;
        }
        case "/zones":
          result = url.searchParams.get("name") === "example.com" ? [{ id: zone }] : [];
          break;
        case "/dns_records":
          result = [];
          break;
        case "/email/sending/subdomains":
          result = request.method === "GET" ? (created ? [{ id: "mail", name: "notify.example.com" }] : []) : { id: "mail" };
          break;
        case "/email/sending/subdomains/mail/dns":
          result = [];
          break;
        default:
          throw new Error(`Unexpected fixture route ${path}`);
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ success: true, result, result_info: { page: 1, total_pages: 1 } }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, errors: [{ message: String(error) }] }));
    }
  });
  try {
    await mkdir(join(dir, "bin"));
    // Only the explicitly retained curl read is stubbed; every cf call uses the real CLI.
    await writeFile(join(dir, "bin/curl"), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({success:true,result:[]}));\n", {
      mode: 0o700,
    });
    const settings = join(dir, "settings.env");
    await writeFile(
      settings,
      "WORKER_NAME=example-kudos\nPUBLIC_URL=https://kudos.example.com\nDIRECTORY_SOURCE=lark\nADMIN_EMAILS=admin@example.com\nALLOWED_EMAIL_DOMAINS=example.com\nEMAIL_NOTIFY=1\nEMAIL_FROM=kudos@notify.example.com\n",
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CF_|CLOUDFLARE_)/.test(key))),
      CF_SEND_TELEMETRY: "false",
      ENV_FILE: settings,
      CLOUDFLARE_ENV_FILE: join(dir, "missing.env"),
      CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${port}`,
      CLOUDFLARE_API_TOKEN: "fixture-token",
      CLOUDFLARE_ACCOUNT_ID: account,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    };
    const run = () => promisify(execFile)("bash", [join(root, "scripts/cloudflare-setup.sh"), "--enable-email"], { cwd: root, env });
    await run();
    assert.deepEqual(
      writes.map(({ path }) => path),
      ["/d1/database", "/r2/buckets", "/access/policies", "/access/apps", "/email/sending/subdomains"],
    );
    assert.deepEqual(writes[2]?.body.include, [{ email_domain: { domain: "example.com" } }]);
    assert.deepEqual(writes[3]?.body.policies, [{ id: "policy", precedence: 1 }]);
    assert.equal(writes[4]?.body.name, "notify.example.com");
    assert.match(await readFile(settings, "utf8"), new RegExp(`D1_DATABASE_ID=${db}`));
    created = true;
    writes.length = 0;
    await run();
    assert.deepEqual(
      writes.map(({ path }) => path),
      ["/access/policies/policy"],
    );
    foreignPolicy = true;
    writes.length = 0;
    await run();
    assert.deepEqual(writes, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
