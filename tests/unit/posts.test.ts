import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../src/server/errors.ts";
import { type NewPost, preparePost } from "../../src/server/post-rules.ts";
import { LIMITS } from "../../src/shared/values.ts";

const valid: NewPost = { kind: "bonus", recipientIds: [2], message: "Thank you for helping the team" };
const prepare = (input: Partial<NewPost> = {}) => preparePost({ ...valid, ...input }, 1, 3);
function rejects(input: Partial<NewPost>, code: string) {
  assert.throws(
    () => prepare(input),
    (error) => error instanceof HttpError && error.status === 400 && error.code === code,
  );
}

test("bonus charges each unique recipient and never charges CC", () => {
  const post = prepare({
    recipientIds: [2, "2", 3],
    ccIds: [1, 2, 4, 4],
    message: "  Thanks for helping our team  ",
    valueTag: "teamwork",
  });
  assert.deepEqual(post, {
    kind: "bonus",
    ids: [2, 3],
    ccIds: [1, 4],
    message: "Thanks for helping our team",
    valueTag: "teamwork",
    points: 3,
    cost: 6,
  });
});
test("self kudos is free; self bonus is rejected", () => {
  assert.equal(prepare({ kind: "kudos", recipientIds: [1], message: "Good!" }).cost, 0);
  rejects({ recipientIds: [1, 2] }, "no_self_bonus");
});
test("message validation uses trimmed content and exact bonus limits", () => {
  rejects({ kind: "unknown" }, "bad_kind");
  for (const message of [null, {}, " \n "]) rejects({ message }, "message_required");
  rejects({ message: "a".repeat(9) }, "message_too_short");
  assert.equal(prepare({ message: "a".repeat(10) }).message.length, 10);
  assert.equal(prepare({ message: "a".repeat(1000) }).message.length, 1000);
  rejects({ message: "a".repeat(1001) }, "message_too_long");
});
test("recipients and CC enforce limits after deduplication", () => {
  for (const recipientIds of [[], null, ["invalid"], [2.5]]) rejects({ recipientIds }, "recipients_required");
  const recipientIds = Array.from({ length: LIMITS.recipientsMax }, (_, i) => i + 2);
  assert.equal(prepare({ recipientIds }).ids.length, 20);
  rejects({ recipientIds: [...recipientIds, 99] }, "too_many_recipients");
  rejects({ ccIds: ["invalid"] }, "cc_not_found");
  const ccIds = Array.from({ length: LIMITS.ccMax }, (_, i) => i + 50);
  assert.equal(prepare({ ccIds }).ccIds.length, 10);
  rejects({ ccIds: [...ccIds, 99] }, "too_many_cc");
});
test("unknown value tags cannot be stored as recognized values", () => {
  assert.equal(prepare({ valueTag: "removed-tag" }).valueTag, null);
  assert.equal(prepare({ valueTag: { id: "teamwork" } }).valueTag, null);
});
