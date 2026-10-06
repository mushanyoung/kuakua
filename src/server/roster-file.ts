// The roster is a CSV (or a JSON array of objects with the same keys) listing everyone
// who can be thanked; see deploy/roster.example.csv. This module only parses and
// validates text, so the Worker (reading it from R2) and local scripts (reading it from
// disk) share it. Local scripts add file checks for avatars.

export const ROSTER_COLUMNS = ["email", "name", "en_name", "department", "department_en", "title", "manager", "avatar"] as const;

export type RosterAvatar =
  // A path relative to the roster file, normalised to forward slashes ("avatars/alice.jpg").
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

export type RosterEntry = {
  line: number;
  email: string;
  name: string;
  enName: string | null;
  department: string | null;
  departmentEn: string | null;
  title: string | null;
  manager: string | null;
  avatar: RosterAvatar | null;
};

export type ParsedRoster = { entries: RosterEntry[]; errors: string[]; warnings: string[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// "./avatars/../avatars/a.jpg" → "avatars/a.jpg"; null if it escapes the roster's folder.
export function normalizeRelative(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.length ? out.join("/") : null;
}

function readRows(text: string, json: boolean): { rows: { line: number; cells: Record<string, string> }[]; columns: string[] } {
  if (json) {
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

export function parseRoster(text: string, json = false): ParsedRoster {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: ReturnType<typeof readRows>;
  try {
    parsed = readRows(text.replace(/^﻿/, ""), json);
  } catch (e) {
    return { entries: [], errors: [(e as Error).message], warnings };
  }
  const { rows, columns } = parsed;
  const unknown = columns.filter((c) => !ROSTER_COLUMNS.includes(c as never));
  if (unknown.length) warnings.push(`unknown columns ignored: ${unknown.join(", ")}`);
  for (const required of ["email", "name"]) {
    if (!columns.includes(required)) errors.push(`missing required column "${required}"`);
  }
  if (errors.length) return { entries: [], errors, warnings };

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

    let avatar: RosterAvatar | null = null;
    const raw = get("avatar");
    if (raw && /^https?:\/\//i.test(raw)) avatar = { kind: "url", url: raw };
    else if (raw) {
      const path = normalizeRelative(raw);
      if (path) avatar = { kind: "file", path };
      else warnings.push(`${at}: avatar for ${email} must be inside the roster's folder: ${raw}`);
    }

    let manager = get("manager")?.toLowerCase() ?? null;
    if (manager === email) manager = null;
    entries.push({
      line,
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
