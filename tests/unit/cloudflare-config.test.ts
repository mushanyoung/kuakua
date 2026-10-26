import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAndParseConfig } from "@cloudflare/config";
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
  assert.ok(result.data.worker);
  return result.data.worker;
}

test("development keeps the existing local D1/R2 identities and simulated login", async () => {
  const worker = await parse();
  assert.deepEqual(worker.env?.DB, { type: "d1", name: "kuakua", id: "local-dev" });
  assert.deepEqual(worker.env?.FILES, { type: "r2", name: "kuakua-files" });
  assert.deepEqual(worker.env?.ENVIRONMENT, { type: "text", value: "development" });
  assert.deepEqual(worker.env?.DEV_AUTH_EMAIL, { type: "text", value: "mushan@example.com" });
  assert.deepEqual(worker.assets?.runWorkerFirst, ["/api/*", "/avatars/*"]);
});

test("production binds existing resources, restricts entrypoints and omits development identity", async () => {
  const worker = await parse({ ...deployment, DEV_AUTH_EMAIL: "ignored@example.com", SYNC_CRON: "0 1 * * *" });
  assert.equal(worker.name, deployment.WORKER_NAME);
  assert.deepEqual(worker.env?.DB, { type: "d1", name: deployment.WORKER_NAME, id: deployment.D1_DATABASE_ID });
  assert.deepEqual(worker.env?.FILES, { type: "r2", name: "example-kudos-files" });
  assert.deepEqual(worker.env?.ENVIRONMENT, { type: "text", value: "production" });
  assert.equal(worker.env?.DEV_AUTH_EMAIL, undefined);
  assert.equal(worker.workersDev, false);
  assert.equal(worker.previewUrls, false);
  assert.deepEqual(worker.domains, ["kudos.example.com"]);
  assert.deepEqual(worker.triggers, [{ type: "scheduled", schedule: "0 1 * * *" }]);
});

test("secrets stay out of build variables and email binding follows the deployment switch", async () => {
  const settings = { ...deployment, LARK_APP_SECRET: "test-secret-not-for-build-output", EMAIL_NOTIFY: "0" };
  const worker = await parse(settings);
  assert.deepEqual(worker.env?.LARK_APP_SECRET, { type: "secret" });
  assert.equal(JSON.stringify(worker).includes(settings.LARK_APP_SECRET), false);
  assert.equal(worker.env?.EMAIL, undefined);
  assert.deepEqual((await parse({ ...settings, EMAIL_NOTIFY: "1" })).env?.EMAIL, { type: "send-email" });
});

test("production rejects missing resource identity and invalid public URL", () => {
  assert.throws(() => createWorkerConfig({ ...deployment, D1_DATABASE_ID: "" }), /D1_DATABASE_ID/);
  assert.throws(() => createWorkerConfig({ ...deployment, PUBLIC_URL: "" }), /Invalid URL/);
});

test("unknown modes cannot silently select the development Worker", () => {
  assert.throws(() => config({ mode: "prodution", isPreview: false }), /Unknown mode/);
});
