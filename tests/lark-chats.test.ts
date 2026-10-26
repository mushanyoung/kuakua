import { required } from "../src/shared/required.ts";
/// <reference path="../.cloudflare/types/index.d.ts" />

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createTestHarness } from "wrangler";
import type { LarkChatMembers, LarkChatPage, Me, PostDetail } from "../src/web/api";
import { testWorkerConfig } from "./support/config.ts";

// Exercise the real Worker and D1 against a local Lark HTTP stub. No real app
// credentials, directory sync, notifications or production data are involved.
let reply: (url: URL) => { code: number; data?: unknown };
const seen: URL[] = [];
const upstream = createServer((req, res) => {
  const url = new URL(required(req.url), "http://lark.test");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
    res.end(JSON.stringify({ code: 0, tenant_access_token: "test-token", expire: 7200 }));
    return;
  }
  seen.push(url);
  assert.equal(req.headers.authorization, "Bearer test-token");
  res.end(JSON.stringify(reply(url)));
});
const server = createTestHarness();
const worker = server.getWorker<Env>();
let env: Env;
let larkBaseUrl: string;
const vars = {
  DEV_AUTH_EMAIL: "self@example.com",
  ADMIN_EMAILS: "admin@example.com",
  ALLOWED_EMAIL_DOMAINS: "",
  DIRECTORY_SOURCE: "lark",
  LARK_APP_ID: "test-app",
  LARK_NOTIFY: "0",
  EMAIL_NOTIFY: "0",
};
const request = (path: string, email = "self@example.com") => worker.fetch(path, { headers: { "X-Dev-Email": email } });
const members = (ids: string[], more = false, cursor?: string) => ({
  code: 0,
  data: { items: ids.map((id) => ({ member_id: id, member_id_type: "open_id" })), has_more: more, page_token: cursor },
});

before(
  async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const { port } = upstream.address() as { port: number };
    larkBaseUrl = `http://127.0.0.1:${port}`;
    await server.update({
      workers: [
        {
          config: testWorkerConfig({ ...vars, LARK_BASE_URL: larkBaseUrl, LARK_APP_SECRET: "test-secret" }),
        },
      ],
    });
    await server.listen();
    await worker.applyD1Migrations("DB");
    env = await worker.getEnv();
  },
  { timeout: 30_000 },
);

after(async () => {
  await server.close();
  await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(async () => {
  seen.length = 0;
  reply = () => ({ code: 0, data: { items: [], has_more: false } });
  await env.DB.batch([env.DB.prepare("DELETE FROM posts"), env.DB.prepare("DELETE FROM users")]);
  await env.DB.batch(
    ["admin", "self", "other", "inactive", "roster"].map((name, i) =>
      env.DB.prepare(
        "INSERT INTO users (id, open_id, email, name, active, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1)",
      ).bind(i + 1, `ou_${name}`, `${name}@example.com`, name, name === "inactive" ? 0 : 1, name === "roster" ? "roster" : "lark"),
    ),
  );
});

test("group capability is independent of notifications and available to signed-in colleagues", async () => {
  const me = (await (await request("/api/me")).json()) as Me;
  assert.equal(me.config.larkChats, true);
  assert.deepEqual(me.config.notify, []);
  assert.equal(me.isAdmin, false);
  assert.equal((await request("/api/lark/chats")).status, 200);
  seen.length = 0;
  assert.equal((await request("/api/lark/chats", "outsider@invalid.example")).status, 403);
  assert.equal((await request("/api/lark/chats/oc_group/members", "outsider@invalid.example")).status, 403);
  assert.equal(seen.length, 0);
});

test("lists joined groups with stable pagination and omits dissolved groups", async () => {
  reply = (url) => {
    assert.equal(url.pathname, "/open-apis/im/v1/chats");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(url.searchParams.get("sort_type"), "ByCreateTimeAsc");
    return {
      code: 0,
      data: url.searchParams.has("page_token")
        ? {
            items: [{ chat_id: "oc_second", name: "第二群", chat_status: "normal" }],
            has_more: false,
          }
        : {
            items: [
              { chat_id: "oc_first", name: "第一群", description: "项目组", chat_status: "normal", owner_id: "private" },
              { chat_id: "oc_gone", name: "旧群", chat_status: "dissolved" },
            ],
            has_more: true,
            page_token: "next+/=",
          },
    };
  };
  const first = (await (await request("/api/lark/chats")).json()) as LarkChatPage;
  assert.deepEqual(first, { chats: [{ id: "oc_first", name: "第一群", description: "项目组" }], nextCursor: "next+/=" });
  const second = (await (await request(`/api/lark/chats?cursor=${encodeURIComponent(required(first.nextCursor))}`)).json()) as LarkChatPage;
  assert.deepEqual(
    second.chats.map((c) => c.id),
    ["oc_second"],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(required(seen[1]).searchParams.get("page_token"), "next+/=");
});

test("members match active Lark users by open_id, with pagination, deduplication and skipped counts", async () => {
  reply = (url) => {
    assert.equal(url.searchParams.get("member_id_type"), "open_id");
    return url.searchParams.has("page_token")
      ? members(["ou_other"])
      : members(["ou_self", "ou_self", "ou_inactive", "ou_external", "ou_roster"], true, "page2");
  };
  const first = (await (await request("/api/lark/chats/oc_group/members")).json()) as LarkChatMembers;
  assert.deepEqual(Object.keys(first.users), ["2"]);
  assert.equal(required(first.users[2]).name, "self");
  assert.equal(first.skipped, 3);
  assert.equal(first.nextCursor, "page2");
  assert.equal("open_id" in required(first.users[2]), false);
  assert.equal("email" in required(first.users[2]), false);
  const second = (await (await request("/api/lark/chats/oc_group/members?cursor=page2")).json()) as LarkChatMembers;
  assert.deepEqual(Object.keys(second.users), ["3"]);
  assert.equal(second.nextCursor, null);
});

test("large groups are returned in full; sending still enforces the existing recipient limit", async () => {
  await env.DB.batch(
    Array.from({ length: 25 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO users (id, open_id, email, name, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'lark', 1, 1)",
      ).bind(10 + i, `ou_member${i}`, `member${i}@example.com`, `Member ${i}`),
    ),
  );
  reply = () => members(Array.from({ length: 25 }, (_, i) => `ou_member${i}`));
  const group = (await (await request("/api/lark/chats/oc_large/members")).json()) as LarkChatMembers;
  const ids = Object.values(group.users).map((u) => u.id);
  assert.equal(ids.length, 25);
  const send = (recipientIds: number[]) =>
    worker.fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dev-Email": "self@example.com" },
      body: JSON.stringify({ kind: "kudos", message: "Thank you, team!", recipientIds }),
    });
  const tooMany = await send(ids);
  assert.equal(tooMany.status, 400);
  assert.equal(((await tooMany.json()) as { error: string }).error, "too_many_recipients");
  const sent = await send(ids.slice(0, 20));
  assert.equal(sent.status, 200);
  assert.deepEqual(
    ((await sent.json()) as PostDetail).post.recipientIds.sort((a, b) => a - b),
    ids.slice(0, 20),
  );
});

test("missing permissions, missing bot capability and inaccessible groups have actionable errors", async () => {
  for (const [code, expected] of [
    [99991672, "lark_chats_permission"],
    [232025, "lark_chats_permission"],
    [232011, "lark_chat_unavailable"],
    [232009, "lark_chat_unavailable"],
  ] as const) {
    reply = () => ({ code });
    const res = await request("/api/lark/chats/oc_group/members");
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: expected });
  }
});

test("invalid IDs cannot alter the upstream path; broken pagination fails instead of returning partial membership", async () => {
  assert.equal((await request("/api/lark/chats/oc_group%2F..%2Fother/members")).status, 400);
  assert.equal(seen.length, 0);
  reply = () => members(["ou_self"], true);
  assert.equal((await request("/api/lark/chats/oc_group/members")).status, 502);
  reply = () => members(["ou_self"], true, "same");
  assert.equal((await request("/api/lark/chats/oc_group/members?cursor=same")).status, 502);
  reply = () => ({ code: 0, data: { items: [{ member_id: "wrong", member_id_type: "user_id" }], has_more: false } });
  assert.equal((await request("/api/lark/chats/oc_group/members")).status, 502);
});

test("roster deployments and missing Lark credentials hide and reject group access", async () => {
  for (const overrides of [{ DIRECTORY_SOURCE: "roster" }, { LARK_APP_ID: "" }]) {
    await server.update((options) => ({
      ...options,
      workers: [
        {
          ...required(options.workers[0]),
          vars: { ...vars, LARK_BASE_URL: larkBaseUrl, ...overrides },
          secrets: { LARK_APP_SECRET: "test-secret" },
        },
      ],
    }));
    assert.equal(((await (await request("/api/me")).json()) as Me).config.larkChats, false);
    assert.equal((await request("/api/lark/chats")).status, 409);
    assert.equal((await request("/api/lark/chats/oc_group/members")).status, 409);
  }
  assert.equal(seen.length, 0);
});
