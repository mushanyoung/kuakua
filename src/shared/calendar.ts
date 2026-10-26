import { required } from "./required.ts";
export type Range = "month" | "quarter" | "year" | "all";
export const isPeriod = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export function createCalendar(timezone: string) {
  // All "this month / quarter / year" boundaries are computed in APP_TIMEZONE so the
  // monthly bonus allowance resets at local midnight, not UTC.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function parts(ms: number) {
    const p: Record<string, number> = {};
    for (const { type, value } of fmt.formatToParts(new Date(ms))) {
      if (type !== "literal") p[type] = Number(value);
    }
    return {
      y: required(p.year),
      m: required(p.month),
      d: required(p.day),
      h: required(p.hour),
      mi: required(p.minute),
      s: required(p.second),
    };
  }

  function offsetAt(ms: number) {
    const p = parts(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }

  function localMidnight(y: number, m: number, d = 1) {
    const guess = Date.UTC(y, m - 1, d);
    let t = guess - offsetAt(guess);
    const again = offsetAt(t);
    if (guess - again !== t) t = guess - again;
    return t;
  }

  function periodOf(ms = Date.now()) {
    const { y, m } = parts(ms);
    return `${y}-${String(m).padStart(2, "0")}`;
  }

  function periodBounds(period: string) {
    const [y, m] = period.split("-").map(Number) as [number, number];
    const start = localMidnight(y, m);
    const end = m === 12 ? localMidnight(y + 1, 1) : localMidnight(y, m + 1);
    return { start, end };
  }

  function rangeStart(range: Range, now = Date.now()) {
    const { y, m } = parts(now);
    if (range === "month") return localMidnight(y, m);
    if (range === "quarter") return localMidnight(y, Math.floor((m - 1) / 3) * 3 + 1);
    if (range === "year") return localMidnight(y, 1);
    return 0;
  }

  return { periodOf, periodBounds, rangeStart };
}
