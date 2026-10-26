import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRelative, parseCsv, parseRoster } from "../../src/server/roster-file.ts";

test("CSV preserves quoted commas, quotes, newlines and CRLF", () => {
  assert.deepEqual(parseCsv('email,name\r\na@example.com,"Alice, ""A""\nTeam"\r\n'), [
    ["email", "name"],
    ["a@example.com", 'Alice, "A"\nTeam'],
  ]);
  assert.throws(() => parseCsv('name\n"unfinished'), /unterminated/);
});
test("roster normalizes identity, manager and avatar paths", () => {
  const r = parseRoster(
    "\ufeffname,email,manager,avatar\nAlice,ALICE@EXAMPLE.COM,alice@example.com,./avatars/../avatars/a.png\n# ignored\n",
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.entries[0]?.email, "alice@example.com");
  assert.equal(r.entries[0]?.manager, null);
  assert.deepEqual(r.entries[0]?.avatar, { kind: "file", path: "avatars/a.png" });
});
test("invalid identities, empty rosters and malformed JSON are reported", () => {
  for (const source of [
    "name\nAlice",
    "email,name\n",
    "email,name\nnot-email,Alice",
    "email,name\na@example.com,",
    "email,name\na@example.com,A\nA@EXAMPLE.COM,B",
  ]) {
    assert.ok(parseRoster(source).errors.length > 0, source);
  }
  assert.ok(parseRoster("{", true).errors.length > 0);
  assert.ok(parseRoster("{}", true).errors.length > 0);
  assert.deepEqual(parseRoster('[{"email":"a@example.com","name":"Alice"}]', true).errors, []);
});
test("avatar traversal and missing managers produce actionable warnings", () => {
  assert.equal(normalizeRelative("../../secret"), null);
  assert.equal(normalizeRelative("avatars/../../secret"), null);
  assert.equal(normalizeRelative("avatars\\a.png"), "avatars/a.png");
  const r = parseRoster("email,name,avatar,manager\na@example.com,Alice,../private.png,b@example.com");
  assert.equal(r.warnings.length, 2);
  assert.equal(r.entries[0]?.avatar, null);
});
