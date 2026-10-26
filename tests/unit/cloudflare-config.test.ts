import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToWranglerConfig, resolveAndParseConfig } from "@cloudflare/config";
import type { Unstable_RawConfig } from "wrangler";
import config from "../../cloudflare.config.ts";
import { createWorkerConfig } from "../../scripts/lib/worker-config.ts";

const deployment = {
  WORKER_NAME: "example-kudos",
  PUBLIC_URL: "https://kudos.example.com",
  D1_DATABASE_ID: "00000000-0000-4000-8000-000000000001",
  ADMIN_EMAILS: "admin@example.com",
};

async function parse(production?: Record<string, string>) {
  const result = await resolveAndParseConfig({ worker: createWorkerConfig(production) }, { mode: undefined, isPreview: false });
  if (!result.success) throw result.error;
  const legacy: Omit<Unstable_RawConfig, "env"> = convertToWranglerConfig(result.data);
  return legacy;
}

test("development keeps the existing local D1/R2 identities and simulated login", async () => {
  const worker = await parse();
  assert.equal(worker.d1_databases?.[0]?.database_id, "local-dev");
  assert.equal(worker.r2_buckets?.[0]?.bucket_name, "kuakua-files");
  assert.equal(worker.vars?.ENVIRONMENT, "development");
  assert.equal(worker.vars?.DEV_AUTH_EMAIL, "mushan@example.com");
  assert.deepEqual(worker.assets?.run_worker_first, ["/api/*", "/avatars/*"]);
});

test("production binds existing resources, restricts entrypoints and omits development identity", async () => {
  const worker = await parse({ ...deployment, DEV_AUTH_EMAIL: "ignored@example.com", SYNC_CRON: "0 1 * * *" });
  assert.equal(worker.name, deployment.WORKER_NAME);
  assert.equal(worker.d1_databases?.[0]?.database_id, deployment.D1_DATABASE_ID);
  assert.equal(worker.r2_buckets?.[0]?.bucket_name, "example-kudos-files");
  assert.equal(worker.vars?.ENVIRONMENT, "production");
  assert.equal(worker.vars?.DEV_AUTH_EMAIL, undefined);
  assert.equal(worker.workers_dev, false);
  assert.equal(worker.preview_urls, false);
  assert.deepEqual(worker.routes, [{ pattern: "kudos.example.com", custom_domain: true }]);
  assert.deepEqual(worker.triggers?.crons, ["0 1 * * *"]);
});

test("secrets stay out of build variables and email binding follows the deployment switch", async () => {
  const settings = { ...deployment, LARK_APP_SECRET: "test-secret-not-for-build-output", EMAIL_NOTIFY: "0" };
  const worker = await parse(settings);
  assert.equal(worker.vars?.LARK_APP_SECRET, undefined);
  assert.equal(JSON.stringify(worker).includes(settings.LARK_APP_SECRET), false);
  assert.equal(worker.send_email, undefined);
  assert.deepEqual((await parse({ ...settings, EMAIL_NOTIFY: "1" })).send_email, [{ name: "EMAIL" }]);
});

test("production rejects missing resource identity and invalid public URL", () => {
  assert.throws(() => createWorkerConfig({ ...deployment, D1_DATABASE_ID: "" }), /D1_DATABASE_ID/);
  assert.throws(() => createWorkerConfig({ ...deployment, PUBLIC_URL: "" }), /Invalid URL/);
});

test("unknown modes cannot silently select the development Worker", () => {
  assert.throws(() => config({ mode: "prodution", isPreview: false }), /Unknown mode/);
});
