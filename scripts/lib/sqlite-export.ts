// Exports generated demo rows for loading into the local D1 development database.
import type { DatabaseSync } from "node:sqlite";

// Parents before children, so foreign keys hold while importing.
const TABLES = ["departments", "users", "posts", "post_recipients", "post_cc", "reactions", "comments", "sync_runs"] as const;

const literal = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

export function exportRows(db: DatabaseSync) {
  const out: string[] = ["PRAGMA defer_foreign_keys = true;"];
  for (const t of [...TABLES].reverse()) out.push(`DELETE FROM ${t};`);
  for (const table of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const cols = Object.keys(row);
      out.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => literal(row[c])).join(", ")});`);
    }
  }
  return out.join("\n") + "\n";
}
