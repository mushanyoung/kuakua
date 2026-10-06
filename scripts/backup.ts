// Snapshot the database before a deploy: `bun scripts/backup.ts <label>`.
// Writes <DATA_DIR>/backups/pre-deploy-<label>-<timestamp>.db and keeps the newest 10.
// (The app itself keeps 14 daily kuakua-YYYY-MM-DD.db snapshots in the same folder.)
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const dataDir = resolve(ROOT, Bun.spawnSync(["bun", join(ROOT, "scripts/config.ts"), "get", "DATA_DIR", "--raw"]).stdout.toString().trim());
const dbFile = join(dataDir, "kuakua.db");
if (!existsSync(dbFile)) {
  console.log(`no database at ${dbFile} yet; nothing to back up`);
  process.exit(0);
}
const dir = join(dataDir, "backups");
mkdirSync(dir, { recursive: true });
const label = (process.argv[2] ?? "manual").replace(/[^a-zA-Z0-9_.-]/g, "_");
const file = join(dir, `pre-deploy-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
const db = new Database(dbFile);
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
for (const old of readdirSync(dir).filter((f) => f.startsWith("pre-deploy-")).sort().slice(0, -10)) rmSync(join(dir, old));
console.log(`backed up to ${file}`);
