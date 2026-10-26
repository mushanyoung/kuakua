import assert from "node:assert/strict";
import { test } from "node:test";
import { parseValues } from "../../src/shared/values.ts";

test("custom value tags have trimmed labels and valid defaults", () => {
  const [tag] = parseValues([{ id: "team", zh: " 团队 " }]);
  assert.deepEqual(tag, { id: "team", zh: "团队", en: "团队", color: "#7FB2FF", icon: "heart" });
});
test("invalid and duplicate tags cannot silently replace the vocabulary", () => {
  for (const input of [
    null,
    [],
    [null],
    [{ id: "Bad ID", zh: "名" }],
    [{ id: "ok", zh: " " }],
    [{ id: "ok", zh: "名", color: "red" }],
    [{ id: "ok", zh: "名", icon: "unknown" }],
    [
      { id: "ok", zh: "名" },
      { id: "ok", zh: "名" },
    ],
  ]) {
    assert.throws(() => parseValues(input));
  }
});
