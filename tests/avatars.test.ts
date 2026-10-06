/// <reference path="../src/server/worker-configuration.d.ts" />
import { after as afterAll, before as beforeAll, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness } from "wrangler";
import type { User } from "../src/web/api";
import { MAX_AVATAR_BYTES } from "../src/shared/avatars.ts";

// Real Workers runtime, isolated local D1/R2, no Cloudflare account or production data.
const server = createTestHarness({ workers: [{
  configPath: "wrangler.jsonc",
  vars: { DEV_AUTH_EMAIL: "admin@example.com", ADMIN_EMAILS: "admin@example.com", EMAIL_NOTIFY: "0" },
}] });
const worker = server.getWorker<Env>();
let env: Env;
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
const request = (path: string, method = "GET", body?: Uint8Array | string, email = "self@example.com") =>
  worker.fetch(path, { method, body, headers: { "X-Dev-Email": email, "Content-Type": "image/png" } });
const upload = (id: string | number = "me", email = "self@example.com") => request(`/api/users/${id}/avatar`, "PUT", png, email);
const current = async () => (await (await request("/api/users/2")).json() as { user: User }).user;
const customKeys = async () => (await env.FILES.list({ prefix: "custom-avatars/" })).objects.map((o) => o.key);

beforeAll(async () => {
  await server.listen();
  await worker.applyD1Migrations("DB");
  env = await worker.getEnv();
}, { timeout: 30_000 });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM users"), env.DB.prepare("DELETE FROM sync_runs")]);
  const objects = (await env.FILES.list()).objects;
  if (objects.length) await env.FILES.delete(objects.map((o) => o.key));
  await env.DB.batch(["admin", "self", "other"].map((name, i) => env.DB.prepare(
    "INSERT INTO users (id, email, name, source, created_at, updated_at) VALUES (?1, ?2, ?3, 'roster', 1, 1)",
  ).bind(i + 1, `${name}@example.com`, name)));
});

test("upload replaces initials at both sizes and removal restores them", async () => {
  const original = await current();
  assert.equal(original.customAvatar, false);
  assert.ok(((await request(original.avatar)).headers.get("content-type"))?.includes("image/svg+xml"));
  const uploaded = await upload();
  assert.equal(uploaded.status, 200);
  const user = await uploaded.json() as User;
  assert.equal(user.customAvatar, true);
  assert.notEqual(user.avatar, original.avatar);
  for (const suffix of ["", "&s=640"]) {
    const image = await request(user.avatar + suffix);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.ok((image.headers.get("cache-control"))?.includes("immutable"));
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  }
  const removed = await request("/api/users/me/avatar", "DELETE");
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as User).avatar, original.avatar);
  assert.deepEqual(await customKeys(), []);
  assert.equal((await request("/api/users/me/avatar", "DELETE")).status, 200);
});

test("ordinary users cannot edit others; admins can upload and restore anyone's avatar", async () => {
  assert.equal((await upload(3)).status, 403);
  assert.equal((await request("/api/users/3/avatar", "DELETE")).status, 403);
  assert.equal((await upload(2, "admin@example.com")).status, 200);
  assert.equal((await current()).customAvatar, true);
  assert.equal((await request("/api/users/2/avatar", "DELETE", undefined, "other@example.com")).status, 403);
  assert.equal((await request("/api/users/2/avatar", "DELETE", undefined, "admin@example.com")).status, 200);
  assert.equal((await current()).customAvatar, false);
  assert.equal((await upload(999, "admin@example.com")).status, 404);
  assert.equal((await upload("me", "nobody@invalid.example")).status, 403);
  assert.equal((await worker.fetch("/api/users/me/avatar", {
    method: "PUT", body: png, headers: { Origin: "https://attacker.example" },
  })).status, 403);
});

test("invalid and oversized files leave the existing avatar unchanged", async () => {
  await upload();
  const original = await current();
  for (const body of ["<svg xmlns='http://www.w3.org/2000/svg'></svg>", "not an image", "", new Uint8Array([0x89, 0x50])]) {
    const r = await request("/api/users/me/avatar", "PUT", body);
    assert.equal(r.status, 415);
    assert.equal((await r.json() as { error: string }).error, "avatar_invalid");
  }
  assert.equal((await request("/api/users/me/avatar", "PUT", new Uint8Array(MAX_AVATAR_BYTES + 1))).status, 413);
  let chunks = 0;
  const streamed = await worker.fetch("/api/users/me/avatar", {
    method: "PUT", duplex: "half", headers: { "X-Dev-Email": "self@example.com" },
    body: new ReadableStream({ pull(controller) {
      if (chunks++ < 6) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    } }),
  });
  assert.equal(streamed.status, 413);
  assert.equal((await current()).avatar, original.avatar);
  assert.equal((await customKeys()).length, 1);
});

test("replacement changes the URL, cleans up old objects, and does not cache stale URLs", async () => {
  const first = await (await upload()).json() as User;
  const key = (await customKeys())[0]!;
  const second = await (await upload()).json() as User;
  assert.notEqual(second.avatar, first.avatar);
  assert.equal(await env.FILES.get(key), null);
  assert.equal((await customKeys()).length, 1);
  assert.ok(((await request(first.avatar)).headers.get("cache-control"))?.includes("no-store"));
  assert.ok(((await request("/avatars/2")).headers.get("cache-control"))?.includes("no-store"));
});

test("roster sync preserves a custom avatar and removal reveals the latest roster image", async () => {
  const uploaded = await (await upload()).json() as User;
  await env.FILES.put("roster/new.png", png, { httpMetadata: { contentType: "image/png" } });
  await env.FILES.put("roster/roster.csv", "email,name,avatar\nadmin@example.com,Admin,\nself@example.com,New name,new.png\nother@example.com,Other,\n");
  await worker.scheduled({ cron: "0 19 * * *" });
  assert.equal((await current()).avatar, uploaded.avatar);
  assert.equal((await current()).name, "New name");
  const restored = await (await request("/api/users/me/avatar", "DELETE")).json() as User;
  assert.equal(restored.customAvatar, false);
  assert.ok((restored.avatar)?.includes("source-"));
  assert.deepEqual(new Uint8Array(await (await request(restored.avatar)).arrayBuffer()), png);
  assert.notEqual(await env.FILES.get("roster/new.png"), null);
});

test("removing an override restores a Lark avatar's 240px and 640px variants", async () => {
  await upload();
  const big = new Uint8Array([...png, 1]);
  await env.FILES.put("avatars/2-240", png, { httpMetadata: { contentType: "image/png" } });
  await env.FILES.put("avatars/2-640", big, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare("UPDATE users SET source='lark', avatar_key='avatars/2-240', avatar_ver='new-lark-version' WHERE id=2").run();
  const restored = await (await request("/api/users/me/avatar", "DELETE")).json() as User;
  assert.deepEqual(new Uint8Array(await (await request(restored.avatar)).arrayBuffer()), png);
  assert.deepEqual(new Uint8Array(await (await request(restored.avatar + "&s=640")).arrayBuffer()), big);
});

test("concurrent replacements retain exactly the current object", async () => {
  await upload();
  const responses = await Promise.all([upload(), upload(), upload()]);
  assert.equal(responses.some((r) => r.status === 200), true);
  assert.equal(responses.every((r) => r.status === 200 || r.status === 409), true);
  const user = await current();
  assert.deepEqual(new Uint8Array(await (await request(user.avatar)).arrayBuffer()), png);
  assert.equal((await customKeys()).length, 1);
});

test("a failed database update cleans up the upload and preserves the old avatar", async () => {
  await upload();
  const original = await current();
  await env.DB.prepare("CREATE TRIGGER reject_avatar BEFORE UPDATE OF custom_avatar_key ON users BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
  try {
    assert.equal((await upload()).status, 500);
    assert.equal((await current()).avatar, original.avatar);
    assert.equal((await customKeys()).length, 1);
  } finally {
    await env.DB.prepare("DROP TRIGGER reject_avatar").run();
  }
});
