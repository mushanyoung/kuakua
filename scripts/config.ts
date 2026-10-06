// Deployment configuration helper. Works on .env.production (or $ENV_FILE) directly, never
// on the database, so it's safe to run any time:
//
//   bun run doctor                    check everything a deployment needs; exit 1 on problems
//   bun run config list               every setting with its current value (secrets masked)
//   bun run config get KEY [--raw]    one value (--raw: unmasked, default applied, for scripts)
//   bun run config set KEY VALUE      write a value (creates the file with mode 600)
//   bun run config example            print .env.example, generated from src/server/settings.ts
//   bun run config access-include     Cloudflare Access include rules (JSON), for cloudflare-setup.sh
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { directorySourceOf, isRequired, SETTINGS, settingByKey, type Setting } from "../src/server/settings";
import { readRoster } from "../src/server/roster-file";
import { parseValues } from "../src/shared/values";

const ROOT = resolve(import.meta.dir, "..");
const ENV_FILE = resolve(ROOT, process.env.ENV_FILE ?? ".env.production");

// ---------------------------------------------------------------- .env file

type Line = { key: string; value: string } | { raw: string };

function parseValue(v: string) {
  v = v.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.startsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : v.slice(1, -1);
  }
  return v;
}

function readEnvFile(file = ENV_FILE): Line[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((raw) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
      return m ? { key: m[1]!, value: parseValue(m[2]!) } : { raw };
    });
}

const fileValues = (lines = readEnvFile()) =>
  Object.fromEntries(lines.flatMap((l) => ("key" in l ? [[l.key, l.value] as const] : []))) as Record<string, string>;

const formatValue = (v: string) => (/^[^\s"'#\\$`]*$/.test(v) ? v : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

function setValue(key: string, value: string) {
  const lines = readEnvFile();
  let done = false;
  const out = lines.flatMap((l) => {
    if (!("key" in l) || l.key !== key) return ["key" in l ? `${l.key}=${formatValue(l.value)}` : l.raw];
    if (done) return []; // drop duplicates
    done = true;
    return [`${key}=${formatValue(value)}`];
  });
  if (!done) {
    while (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${formatValue(value)}`);
  }
  writeFileSync(ENV_FILE, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

// ---------------------------------------------------------------- helpers

const mask = (s: Setting, v: string) => (s.secret && v ? `(set, ${v.length} characters)` : v);
const effective = (env: Record<string, string>, key: string) => env[key] || settingByKey.get(key)?.default || "";

function wrap(text: string, width = 96, prefix = "# ") {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) out.push(prefix + line), (line = word);
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(prefix + line);
  return out.join("\n");
}

// ---------------------------------------------------------------- doctor

function doctor() {
  let failures = 0;
  const ok = (m: string) => console.log(`  ✓ ${m}`);
  const warn = (m: string) => console.log(`  ⚠ ${m}`);
  const fail = (m: string) => (failures++, console.log(`  ✗ ${m}`));
  const section = (m: string) => console.log(`\n${m}`);

  section(`Config file ${ENV_FILE}`);
  if (!existsSync(ENV_FILE)) {
    fail("missing — create it with `bun run config set KEY VALUE` (see AGENTS.md)");
  } else {
    const mode = statSync(ENV_FILE).mode & 0o777;
    if (mode & 0o077) warn(`permissions are ${mode.toString(8)}; it holds secrets — chmod 600 ${ENV_FILE}`);
    else ok("exists, mode 600");
  }
  const lines = readEnvFile();
  const env = fileValues(lines);
  const seen = new Map<string, number>();
  for (const l of lines) if ("key" in l) seen.set(l.key, (seen.get(l.key) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) warn(`${k} is set ${n} times; the last one wins`);

  section("Settings");
  const unreviewed: Setting[] = [];
  for (const s of SETTINGS) {
    const present = s.key in env;
    const value = env[s.key] ?? "";
    if (s.devOnly) {
      if (present && value) fail(`${s.key} must not be set in production (${s.help})`);
      continue;
    }
    if (s.when && !s.when(env)) {
      if (present && value) console.log(`  · ${s.key} is set but unused with DIRECTORY_SOURCE=${directorySourceOf(env)}`);
      continue;
    }
    if (isRequired(s, env) && !value) {
      fail(`${s.key} is required — ${s.help}${s.managed ? " Run scripts/cloudflare-setup.sh." : ""}`);
      continue;
    }
    if (!present) {
      unreviewed.push(s);
      continue;
    }
    const problem = value && s.check ? s.check(value, env) : null;
    if (problem) fail(`${s.key}=${mask(s, value)}: ${problem}`);
    else ok(`${s.key}=${mask(s, value)}${!value && s.default ? ` (default ${s.default})` : ""}`);
  }
  for (const key of seen.keys()) if (!settingByKey.has(key)) warn(`${key} is not a known setting (typo, or removed in a newer version?)`);
  if (unreviewed.length) {
    section("Not in the config file yet (the default applies)");
    for (const s of unreviewed) console.log(`  • ${s.key} = ${s.default ? `"${s.default}"` : "(empty)"} — ${s.help}`);
    console.log("  → Review these with the operator and write each one, even to keep the default:");
    console.log("    bun run config set KEY VALUE   (then doctor stops listing it)");
  }

  section("Directory");
  const source = directorySourceOf(env);
  if (source === "roster") {
    const file = resolve(ROOT, effective(env, "ROSTER_FILE"));
    const roster = readRoster(file);
    for (const e of roster.errors) fail(`roster: ${e}`);
    for (const w of roster.warnings) warn(`roster: ${w}`);
    if (!roster.errors.length) {
      const avatars = roster.entries.filter((e) => e.avatar).length;
      ok(`roster ${file}: ${roster.entries.length} people, ${avatars} with avatars`);
      const admins = effective(env, "ADMIN_EMAILS").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      const emails = new Set(roster.entries.map((e) => e.email));
      for (const a of admins) if (!emails.has(a)) warn(`admin ${a} is not in the roster (can sign in, but can't be thanked)`);
    }
  } else {
    ok(`Lark directory via ${effective(env, "LARK_BASE_URL")} (checked online at runtime; see the admin page)`);
  }

  section("Values");
  const valuesFile = effective(env, "VALUES_FILE");
  if (!valuesFile) ok("built-in values");
  else {
    try {
      const list = parseValues(JSON.parse(readFileSync(resolve(ROOT, valuesFile), "utf8")));
      ok(`${valuesFile}: ${list.map((v) => v.zh).join("、")}`);
    } catch (e) {
      fail(`${valuesFile}: ${(e as Error).message}`);
    }
  }

  section("Machine");
  const dataDir = resolve(ROOT, effective(env, "DATA_DIR"));
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
    ok(`data dir ${dataDir} is writable${existsSync(resolve(dataDir, "kuakua.db")) ? " (database present)" : " (new database will be created)"}`);
  } catch {
    fail(`data dir ${dataDir} is not writable`);
  }
  ok(`bun ${Bun.version}`);
  const has = (cmd: string) => Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]).exitCode === 0;
  if (!has("cloudflared")) warn("cloudflared is not installed (needed to run the Cloudflare tunnel connector)");
  for (const tool of ["jq", "curl"]) if (!has(tool)) warn(`${tool} is not installed (scripts/cloudflare-setup.sh needs it)`);
  const unit = effective(env, "SERVICE_NAME");
  const active = Bun.spawnSync(["systemctl", "is-active", unit]).stdout.toString().trim();
  if (active === "active") ok(`systemd unit ${unit} is active`);
  else warn(`systemd unit ${unit} is ${active || "not installed"} — scripts/deploy.sh installs and starts it`);

  console.log(failures ? `\n${failures} problem(s) to fix before deploying.` : "\nReady to deploy.");
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------- commands

function example() {
  const groups: Record<Setting["group"], string> = {
    site: "Site",
    access: "Who can sign in",
    directory: "People directory",
    lark: "Lark / Feishu (DIRECTORY_SOURCE=lark)",
    app: "Thanks & Peer Bonus",
    ops: "Operations",
  };
  const out = [
    "# kuakua deployment settings. The deployed copy is .env.production (mode 600, never committed);",
    "# `bun run doctor` checks it and `bun run config set KEY VALUE` edits it. Generated from",
    "# src/server/settings.ts by `bun run config example` — edit that file, not this one.",
  ];
  for (const [group, title] of Object.entries(groups)) {
    out.push("", `# ---- ${title}`);
    for (const s of SETTINGS.filter((x) => x.group === group)) {
      const tags = [s.required === true ? "required" : typeof s.required === "function" ? "required when it applies" : null, s.secret ? "secret" : null, s.managed ? "set by scripts/cloudflare-setup.sh" : null]
        .filter(Boolean)
        .join(", ");
      const eg = s.default === "" && s.example ? ` E.g. ${s.example}.` : "";
      out.push(wrap(`${s.help}${eg}${tags ? ` [${tags}]` : ""}`));
      const value = s.default ?? s.example ?? "";
      out.push(s.devOnly ? `# ${s.key}=you@example.com` : `${s.key}=${value}`);
    }
  }
  console.log(out.join("\n"));
}

function accessInclude() {
  const env = fileValues();
  const split = (v: string) => v.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const rules: object[] = split(effective(env, "ALLOWED_EMAIL_DOMAINS")).map((domain) => ({ email_domain: { domain } }));
  const emails = new Set(split(effective(env, "ADMIN_EMAILS")));
  if (directorySourceOf(env) === "roster") {
    const roster = readRoster(resolve(ROOT, effective(env, "ROSTER_FILE")));
    if (roster.errors.length) throw new Error(`roster: ${roster.errors.join("; ")}`);
    for (const e of roster.entries) emails.add(e.email);
  }
  const domains = new Set(split(effective(env, "ALLOWED_EMAIL_DOMAINS")));
  for (const email of emails) if (!domains.has(email.split("@")[1]!)) rules.push({ email: { email } });
  console.log(JSON.stringify(rules));
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "doctor":
    process.exit(doctor());
  case "list": {
    const env = fileValues();
    for (const s of SETTINGS.filter((x) => !x.devOnly)) {
      const v = env[s.key];
      console.log(`${s.key}=${v === undefined ? `(not set, default "${s.default ?? ""}")` : mask(s, v)}`);
    }
    break;
  }
  case "get": {
    const key = args[0];
    if (!key) throw new Error("usage: config get KEY [--raw]");
    const env = fileValues();
    const s = settingByKey.get(key);
    const v = effective(env, key);
    console.log(args.includes("--raw") || !s ? v : mask(s, v));
    break;
  }
  case "set": {
    let [key, ...rest] = args;
    let value = rest.join(" ");
    if (key?.includes("=") && !rest.length) [key, value] = [key.slice(0, key.indexOf("=")), key.slice(key.indexOf("=") + 1)];
    if (!key) throw new Error("usage: config set KEY VALUE");
    const s = settingByKey.get(key);
    if (!s) throw new Error(`${key} is not a known setting; see src/server/settings.ts`);
    if (s.devOnly) throw new Error(`${key} is for local development only`);
    const problem = value && s.check ? s.check(value, fileValues()) : null;
    if (problem) throw new Error(`${key}: ${problem}`);
    setValue(key, value);
    console.log(`${key}=${mask(s, value)} → ${ENV_FILE}`);
    break;
  }
  case "example":
    example();
    break;
  case "access-include":
    accessInclude();
    break;
  default:
    console.log(readFileSync(import.meta.path, "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
    process.exit(cmd ? 1 : 0);
}
