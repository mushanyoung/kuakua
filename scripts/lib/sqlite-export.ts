// Turns the rows of a kuakua SQLite database into INSERT statements for D1 (the schema
// comes from migrations/). Used to move an existing deployment's data into D1 and to
// load the demo data into the local dev database.
import type { Database } from "bun:sqlite";

// Parents before children, so foreign keys hold while importing.
export const TABLES = ["departments", "users", "posts", "post_recipients", "post_cc", "reactions", "comments", "sync_runs"] as const;

const literal = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

export function exportRows(db: Database, opts: { replace?: boolean; transform?: (table: string, row: Record<string, unknown>) => void } = {}) {
  const out: string[] = ["PRAGMA defer_foreign_keys = true;"];
  if (opts.replace) for (const t of [...TABLES].reverse()) out.push(`DELETE FROM ${t};`);
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    counts[table] = rows.length;
    for (const row of rows) {
      opts.transform?.(table, row);
      const cols = Object.keys(row);
      out.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => literal(row[c])).join(", ")});`);
    }
  }
  return { sql: out.join("\n") + "\n", counts };
}

// Column lists of a table, to drop columns the D1 schema doesn't have (or add missing ones).
export function columns(db: Database, table: string) {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}
