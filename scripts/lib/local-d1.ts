import "./privacy.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { LOCAL_DATABASE_ID, LOCAL_STATE, MIGRATIONS_DIR } from "./worker-config.ts";

type QueryResult = { success: boolean; results: { columns: string[]; rows: unknown[][] } };

// cf migrations currently rejects the legacy local-dev ID. cf raw supports it,
// including atomic multi-statement batches, without changing the database identity.
export function localSql(sql: string, persistTo = LOCAL_STATE): QueryResult[] {
  const scratch = mkdtempSync(join(tmpdir(), "kuakua-local-sql-"));
  try {
    const body = join(scratch, "query.json");
    writeFileSync(body, JSON.stringify({ sql }), { mode: 0o600 });
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "node_modules/cf/bin/cf"), "d1", "raw", LOCAL_DATABASE_ID, "--body", `@${body}`, "--local", "--persist-to", persistTo],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const results: QueryResult[] = JSON.parse(output);
    if (results.some((result) => !result.success)) throw new Error("Local D1 query failed");
    return results;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function applyLocalMigrations(persistTo = LOCAL_STATE, directory = join(ROOT, MIGRATIONS_DIR)) {
  const results = localSql(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); SELECT name FROM d1_migrations;",
    persistTo,
  );
  const applied = new Set(results.flatMap((result) => result.results.rows.map((row) => row[0])));
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (applied.has(file)) continue;
    // The schema change and history entry commit together; a failed batch rolls back.
    localSql(
      `${readFileSync(join(directory, file), "utf8")}\nINSERT INTO d1_migrations (name) VALUES ('${file.replaceAll("'", "''")}');`,
      persistTo,
    );
  }
}
