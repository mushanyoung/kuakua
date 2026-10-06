// Moves a machine-hosted kuakua (SQLite + avatar files) into this deployment's D1 and R2.
// Replaces everything in the D1 database, so it's meant for the one-time migration (and
// re-running it right before the switch-over):
//   bun scripts/import-sqlite.ts <path/to/kuakua.db> [--avatars <dir>] [--local]
// --avatars defaults to the avatars/ folder next to the database. --local imports into the
// local dev database instead (bun run dev). Unchanged avatars aren't re-uploaded.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { effective, fileValues, ROOT } from "./lib/env";
import { columns, exportRows, TABLES } from "./lib/sqlite-export";

const args = process.argv.slice(2);
const local = args.includes("--local");
const source = args.find((a) => !a.startsWith("--") && a !== args[args.indexOf("--avatars") + 1]);
if (!source || !existsSync(source)) {
  console.error("usage: bun scripts/import-sqlite.ts <path/to/kuakua.db> [--avatars <dir>] [--local]");
  process.exit(1);
}
const avatarDir = args.includes("--avatars") ? resolve(args[args.indexOf("--avatars") + 1]!) : join(dirname(resolve(source)), "avatars");
const env = local ? {} : fileValues();
const dbName = local ? "kuakua" : effective(env, "WORKER_NAME");
const bucket = local ? "kuakua-files" : `${effective(env, "WORKER_NAME")}-files`;
const target = local ? ["--local"] : ["--remote", "-c", join(ROOT, "local/wrangler.json")];

// The D1 schema's columns, from a scratch database with migrations/ applied.
const scratch = mkdtempSync(join(tmpdir(), "kuakua-import-"));
const schema = new Database(join(scratch, "schema.db"));
for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  schema.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
}
const wanted = Object.fromEntries(TABLES.map((t) => [t, new Set(columns(schema, t))]));
schema.close();

const db = new Database(resolve(source), { readonly: true });
const { sql, counts } = exportRows(db, {
  replace: true,
  transform(table, row) {
    for (const col of Object.keys(row)) if (!wanted[table]!.has(col)) delete row[col];
    // Avatars move to R2 under avatars/<id>-240 (and -640).
    if (table === "users") row.avatar_key = row.avatar_ver ? `avatars/${row.id}-240` : null;
  },
});
db.close();
mkdirSync(join(ROOT, "local"), { recursive: true });
const sqlFile = join(ROOT, "local/import.sql");
writeFileSync(sqlFile, sql);
console.log(`rows: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")}`);

// ---- avatars → R2
const sniff = (b: Uint8Array) =>
  b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[1] === 0x50 && b[2] === 0x4e ? "image/png" : b[8] === 0x57 && b[9] === 0x45 ? "image/webp" : b[0] === 0x47 ? "image/gif" : "application/octet-stream";
const manifestFile = join(ROOT, "local/avatars-uploaded.json");
const manifest: Record<string, Record<string, string>> = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : {};
const uploaded = (manifest[`${local ? "local" : "remote"}:${bucket}`] ??= {});
const files = existsSync(avatarDir) ? readdirSync(avatarDir).filter((f) => /^\d+-(240|640)$/.test(f)) : [];
const queue = files.filter((f) => {
  const hash = new Bun.CryptoHasher("sha1").update(readFileSync(join(avatarDir, f))).digest("hex");
  return uploaded[f] !== hash;
});
let done = 0;
// Local R2 storage doesn't take concurrent writers.
await Promise.all(
  Array.from({ length: local ? 1 : 6 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const path = join(avatarDir, f);
      const bytes = readFileSync(path);
      const proc = Bun.spawn(
        ["bunx", "wrangler", "r2", "object", "put", `${bucket}/avatars/${f}`, "--file", path, "--content-type", sniff(bytes), ...target],
        { cwd: ROOT, stdout: "ignore", stderr: "pipe" },
      );
      if ((await proc.exited) !== 0) throw new Error(`upload ${f}: ${await new Response(proc.stderr).text()}`);
      uploaded[f] = new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
      if (++done % 20 === 0) console.log(`avatars: ${done} uploaded…`);
    }
  }),
);
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`avatars: ${done} uploaded, ${files.length - done} unchanged (${avatarDir})`);

// ---- rows → D1
const exec = Bun.spawnSync(["bunx", "wrangler", "d1", "execute", dbName, "--file", sqlFile, "--yes", ...target], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
rmSync(scratch, { recursive: true, force: true });
if (exec.exitCode !== 0) process.exit(1);
console.log(`imported ${source} into D1 ${dbName}${local ? " (local)" : ""}`);
