import assert from "node:assert/strict";
import { test } from "node:test";
import { createCalendar, isPeriod } from "../../src/shared/calendar.ts";

test("allowance month changes at Shanghai midnight, including year rollover", () => {
  const calendar = createCalendar("Asia/Shanghai");
  assert.equal(calendar.periodOf(Date.parse("2026-12-31T15:59:59.999Z")), "2026-12");
  assert.equal(calendar.periodOf(Date.parse("2026-12-31T16:00:00Z")), "2027-01");
  assert.deepEqual(calendar.periodBounds("2026-12"), {
    start: Date.parse("2026-11-30T16:00:00Z"),
    end: Date.parse("2026-12-31T16:00:00Z"),
  });
});
test("month bounds account for daylight-saving transitions", () => {
  const calendar = createCalendar("America/Los_Angeles");
  assert.deepEqual(calendar.periodBounds("2026-03"), {
    start: Date.parse("2026-03-01T08:00:00Z"),
    end: Date.parse("2026-04-01T07:00:00Z"),
  });
  assert.deepEqual(calendar.periodBounds("2026-11"), {
    start: Date.parse("2026-11-01T07:00:00Z"),
    end: Date.parse("2026-12-01T08:00:00Z"),
  });
});
test("quarter, year and leap-month boundaries are calendar based", () => {
  const c = createCalendar("UTC");
  const now = Date.parse("2024-05-14T12:00:00Z");
  assert.equal(c.rangeStart("quarter", now), Date.parse("2024-04-01T00:00:00Z"));
  assert.equal(c.rangeStart("year", now), Date.parse("2024-01-01T00:00:00Z"));
  assert.equal(c.rangeStart("month", now), Date.parse("2024-05-01T00:00:00Z"));
  assert.equal(c.rangeStart("all", now), 0);
  const { start, end } = c.periodBounds("2024-02");
  assert.equal(end - start, 29 * 86400000);
});
test("report periods and invalid deployment timezones are rejected", () => {
  for (const p of ["2026-00", "2026-13", "26-10", "2026-1", "2026-10-extra"]) assert.equal(isPeriod(p), false);
  assert.equal(isPeriod("2026-10"), true);
  assert.throws(() => createCalendar("Not/A_Timezone"), RangeError);
});
