import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Feed, Me, PostDetail } from "../src/web/api.ts";
import { type App, createApp, request, resetApp } from "./support/app.ts";

let app: App;
before(async () => {
  app = await createApp(true);
});
after(async () => {
  await app?.server.close();
});
beforeEach(async () => {
  await resetApp(app);
});
const send = (extra: Record<string, unknown> = {}) =>
  request(app, "/api/posts", "POST", {
    kind: "bonus",
    recipientIds: [3],
    message: "Thanks for helping the whole team",
    ...extra,
  });

async function posted(extra: Record<string, unknown> = {}) {
  const response = await send(extra);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as PostDetail;
}

test("allowance is atomic under concurrent sends and refunds on deletion", async () => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => send({ recipientIds: [3, 4] })));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409], JSON.stringify(app.server.getLogs()));
  assert.equal(await app.env.DB.prepare("SELECT COUNT(*) FROM posts").first("COUNT(*)"), 1);
  assert.equal(await app.env.DB.prepare("SELECT COUNT(*) FROM post_recipients").first("COUNT(*)"), 2);
  const me = (await (await request(app, "/api/me")).json()) as Me;
  assert.equal(me.allowance.remaining, 0);
  const success = responses.find((r) => r.status === 200);
  assert.ok(success);
  const { post } = (await success.json()) as PostDetail;
  assert.equal((await request(app, `/api/posts/${post.id}`, "DELETE")).status, 200);
  assert.equal((await send({ recipientIds: [3, 4] })).status, 200);
});
test("private content is visible only to sender, recipients and CC", async () => {
  const { post } = await posted({ private: true, ccIds: [4] });
  for (const user of ["alice", "bob", "carol"])
    assert.equal((await request(app, `/api/posts/${post.id}`, "GET", undefined, user)).status, 200);
  for (const user of ["outsider", "admin"]) {
    for (const [suffix, body] of [
      ["", undefined],
      ["/comments", { body: "leak" }],
      ["/reactions", { emoji: "+1" }],
    ] as const) {
      assert.equal((await request(app, `/api/posts/${post.id}${suffix}`, body ? "POST" : "GET", body, user)).status, 404);
    }
    const feed = (await (await request(app, "/api/posts", "GET", undefined, user)).json()) as Feed;
    assert.deepEqual(feed.posts, []);
  }
  assert.equal(await app.env.DB.prepare("SELECT COUNT(*) FROM comments").first("COUNT(*)"), 0);
});
test("inactive and missing targets reject the whole post without charging points", async () => {
  for (const extra of [{ recipientIds: [3, 6] }, { recipientIds: [999] }, { ccIds: [6] }, { ccIds: [999] }])
    assert.equal((await send(extra)).status, 400);
  assert.equal(await app.env.DB.prepare("SELECT COUNT(*) FROM posts").first("COUNT(*)"), 0);
  assert.equal(((await (await request(app, "/api/me")).json()) as Me).allowance.remaining, 2);
});
test("old-month bonus does not consume this month; author cannot delete it, admin can", async () => {
  const { post } = await posted({ recipientIds: [3, 4] });
  await app.env.DB.prepare("UPDATE posts SET period = '2000-01' WHERE id = ?1").bind(post.id).run();
  assert.equal(((await (await request(app, "/api/me")).json()) as Me).allowance.remaining, 2);
  assert.equal((await request(app, `/api/posts/${post.id}`, "DELETE")).status, 403);
  assert.equal((await request(app, `/api/posts/${post.id}`, "DELETE", undefined, "admin")).status, 200);
});
test("admin exports and moderation require authorization", async () => {
  const { post } = await posted();
  assert.equal((await request(app, `/api/posts/${post.id}`, "DELETE", undefined, "bob")).status, 403);
  for (const path of ["/api/admin/status", "/api/admin/bonus-report", "/api/leaderboard"]) {
    assert.equal((await request(app, path)).status, 403);
    assert.equal((await request(app, path, "GET", undefined, "admin")).status, 200);
  }
  assert.equal((await request(app, "/api/me", "GET", undefined, "stranger")).status, 403);
  assert.equal(
    (
      await app.worker.fetch("/api/posts", {
        method: "POST",
        headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
});

test("rejected same-millisecond send cannot add new recipients or CC to an existing post", async () => {
  const { post } = await posted({ recipientIds: [3, 4], ccIds: [1] });
  const rejected = await send({ recipientIds: [5], ccIds: [2] });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: "insufficient_allowance" });
  const detail = (await (await request(app, `/api/posts/${post.id}`)).json()) as PostDetail;
  assert.deepEqual(detail.post.recipientIds, [3, 4]);
  assert.deepEqual(detail.post.ccIds, [1]);
});
test("accepted same-millisecond posts keep their own recipients and CC", async () => {
  const first = await posted({ recipientIds: [3], ccIds: [1] });
  const second = await posted({ recipientIds: [4], ccIds: [5] });
  assert.notEqual(first.post.id, second.post.id);
  for (const [id, recipients, cc] of [
    [first.post.id, [3], [1]],
    [second.post.id, [4], [5]],
  ] as const) {
    const detail = (await (await request(app, `/api/posts/${id}`)).json()) as PostDetail;
    assert.deepEqual(detail.post.recipientIds, recipients);
    assert.deepEqual(detail.post.ccIds, cc);
  }
});
