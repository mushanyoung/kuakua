// Uploads ROSTER_FILE and the avatar files it references to the R2 bucket under roster/,
// then roster/_version (a hash of all of them) — the Worker re-syncs when that changes.
// Unchanged files aren't re-uploaded (local/roster-uploaded.json remembers what went up).
//   bun scripts/push-roster.ts            to the deployment's bucket (run by scripts/deploy.sh)
//   bun scripts/push-roster.ts --local    to the local dev bucket (bun run dev)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { effective, fileValues, ROOT } from "./lib/env";
import { imageType, readRosterFile } from "./lib/roster";

const local = process.argv.includes("--local");
const env = local ? {} : fileValues();
const fileArg = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
const rosterFile = resolve(ROOT, fileArg ?? effective(env, "ROSTER_FILE"));
const bucket = local ? "kuakua-files" : `${effective(env, "WORKER_NAME")}-files`;
const configArgs = local ? [] : ["-c", join(ROOT, "local/wrangler.json")];

const roster = readRosterFile(rosterFile);
for (const w of roster.warnings) console.log(`  ⚠ ${w}`);
if (roster.errors.length) {
  for (const e of roster.errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

const sha1 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
const files: { key: string; path: string; type: string }[] = [];
for (const e of roster.entries) {
  if (e.avatar?.kind === "file") files.push({ key: `roster/${e.avatar.path}`, path: resolve(roster.dir, e.avatar.path), type: imageType(resolve(roster.dir, e.avatar.path))! });
}
const json = rosterFile.toLowerCase().endsWith(".json");
files.push({ key: json ? "roster/roster.json" : "roster/roster.csv", path: rosterFile, type: json ? "application/json" : "text/csv; charset=utf-8" });

const manifestFile = join(ROOT, "local/roster-uploaded.json");
const manifest: Record<string, Record<string, string>> = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : {};
const target = `${local ? "local" : "remote"}:${bucket}`;
const uploaded = (manifest[target] ??= {});

function put(key: string, path: string, type: string) {
  const args = ["bunx", "wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", path, "--content-type", type, local ? "--local" : "--remote", ...configArgs];
  const res = Bun.spawnSync(args, { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`upload ${key} failed: ${res.stderr.toString().trim()}`);
}

const seen = new Set<string>();
let count = 0;
for (const f of files) {
  if (seen.has(f.key)) continue;
  seen.add(f.key);
  const hash = sha1(readFileSync(f.path));
  if (uploaded[f.key] === hash) continue;
  put(f.key, f.path, f.type);
  uploaded[f.key] = hash;
  count++;
}
// One object whose content changes whenever any of the above does.
const version = sha1(new TextEncoder().encode([...seen].sort().map((k) => `${k}:${uploaded[k]}`).join("\n")));
if (uploaded["roster/_version"] !== version) {
  const tmp = join(ROOT, "local/.roster-version");
  mkdirSync(join(ROOT, "local"), { recursive: true });
  writeFileSync(tmp, version);
  put("roster/_version", tmp, "text/plain");
  uploaded["roster/_version"] = version;
}
mkdirSync(join(ROOT, "local"), { recursive: true });
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`roster: ${roster.entries.length} people; uploaded ${count} changed file(s) to ${target}`);
