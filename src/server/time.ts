import { config } from "./config";

// All "this month / quarter / year" boundaries are computed in APP_TIMEZONE so the
// monthly bonus allowance resets at local midnight, not UTC.
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: config.timezone,
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
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
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

export function periodOf(ms = Date.now()) {
  const { y, m } = parts(ms);
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function periodBounds(period: string) {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const start = localMidnight(y, m);
  const end = m === 12 ? localMidnight(y + 1, 1) : localMidnight(y, m + 1);
  return { start, end };
}

export type Range = "month" | "quarter" | "year" | "all";

export function rangeStart(range: Range, now = Date.now()) {
  const { y, m } = parts(now);
  if (range === "month") return localMidnight(y, m);
  if (range === "quarter") return localMidnight(y, Math.floor((m - 1) / 3) * 3 + 1);
  if (range === "year") return localMidnight(y, 1);
  return 0;
}

export const isPeriod = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
