import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

// The roster is a CSV (or JSON array of objects with the same keys) listing everyone
// who can be thanked. See deploy/roster.example.csv. Parsing is kept free of database
// access so `bun run doctor` can check a roster without touching data.

export const ROSTER_COLUMNS = ["email", "name", "en_name", "department", "department_en", "title", "manager", "avatar"] as const;

export type RosterEntry = {
  email: string;
  name: string;
  enName: string | null;
  department: string | null;
  departmentEn: string | null;
  title: string | null;
  manager: string | null;
  avatar: { kind: "file"; path: string } | { kind: "url"; url: string } | null;
};

export type ParsedRoster = { entries: RosterEntry[]; errors: string[]; warnings: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AVATAR_WARN_BYTES = 1024 * 1024;

function looksLikeImage(path: string) {
  const head = new Uint8Array(12);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const ascii = (from: number, s: string) => [...s].every((c, i) => head[from + i] === c.charCodeAt(0));
  return (head[0] === 0xff && head[1] === 0xd8) || ascii(1, "PNG") || ascii(8, "WEBP") || ascii(0, "GIF");
}

// RFC 4180: quoted fields may contain commas, quotes ("") and newlines.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows;
}

function readRows(file: string, text: string): { rows: { line: number; cells: Record<string, string> }[]; columns: string[] } {
  if (extname(file).toLowerCase() === ".json") {
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) throw new Error("expected a JSON array of objects");
    const columns = new Set<string>();
    const rows = data.map((item, i) => {
      if (!item || typeof item !== "object") throw new Error(`entry ${i + 1}: expected an object`);
      const cells: Record<string, string> = {};
      for (const [k, v] of Object.entries(item)) {
        columns.add(k);
        if (v !== null && v !== undefined) cells[k] = String(v);
      }
      return { line: i + 1, cells };
    });
    return { rows, columns: [...columns] };
  }
  const [header, ...body] = parseCsv(text);
  if (!header) return { rows: [], columns: [] };
  const columns = header.map((h) => h.trim().toLowerCase());
  const rows = body
    .map((cells, i) => ({ line: i + 2, cells: Object.fromEntries(columns.map((c, j) => [c, cells[j] ?? ""])) }))
    // Blank lines and lines starting with # are skipped.
    .filter(({ cells }) => Object.values(cells).some((v) => v.trim()) && !(cells[columns[0]!] ?? "").trim().startsWith("#"));
  return { rows, columns };
}

export function readRoster(file: string): ParsedRoster {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(file)) return { entries: [], errors: [`roster file not found: ${file}`], warnings };

  let parsed: ReturnType<typeof readRows>;
  try {
    parsed = readRows(file, readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    return { entries: [], errors: [`${file}: ${(e as Error).message}`], warnings };
  }
  const { rows, columns } = parsed;
  const unknown = columns.filter((c) => !ROSTER_COLUMNS.includes(c as never));
  if (unknown.length) warnings.push(`unknown columns ignored: ${unknown.join(", ")}`);
  for (const required of ["email", "name"]) {
    if (!columns.includes(required)) errors.push(`missing required column "${required}"`);
  }
  if (errors.length) return { entries: [], errors, warnings };

  const base = dirname(file);
  const entries: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const { line, cells } of rows) {
    const get = (k: string) => cells[k]?.trim() || null;
    const at = `line ${line}`;
    const email = get("email")?.toLowerCase() ?? "";
    const name = get("name");
    if (!EMAIL.test(email)) {
      errors.push(`${at}: invalid email "${email}"`);
      continue;
    }
    if (seen.has(email)) {
      errors.push(`${at}: duplicate email ${email}`);
      continue;
    }
    seen.add(email);
    if (!name) {
      errors.push(`${at}: ${email} has no name`);
      continue;
    }

    let avatar: RosterEntry["avatar"] = null;
    const rawAvatar = get("avatar");
    if (rawAvatar && /^https?:\/\//i.test(rawAvatar)) avatar = { kind: "url", url: rawAvatar };
    else if (rawAvatar) {
      const path = resolve(base, rawAvatar);
      if (!existsSync(path)) warnings.push(`${at}: avatar for ${email} not found: ${path}`);
      else if (!looksLikeImage(path)) warnings.push(`${at}: avatar for ${email} is not a JPEG, PNG, WebP or GIF: ${path}`);
      else {
        if (statSync(path).size > AVATAR_WARN_BYTES) warnings.push(`${at}: avatar for ${email} is over 1 MB; a ~640px square is plenty`);
        avatar = { kind: "file", path };
      }
    }

    let manager = get("manager")?.toLowerCase() ?? null;
    if (manager === email) manager = null;
    entries.push({
      email,
      name,
      enName: get("en_name"),
      department: get("department"),
      departmentEn: get("department_en"),
      title: get("title"),
      manager,
      avatar,
    });
  }
  for (const e of entries) {
    if (e.manager && !seen.has(e.manager)) warnings.push(`manager ${e.manager} of ${e.email} is not in the roster`);
  }
  if (!entries.length && !errors.length) errors.push("roster has no people");
  return { entries, errors, warnings };
}
