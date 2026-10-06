// Deployment configuration helper. Works on .env.production (or $ENV_FILE) and local files
// only — never on Cloudflare — so it's safe to run any time:
//
//   bun run doctor                    check everything a deployment needs; exit 1 on problems
//   bun run config list               every setting with its current value (secrets masked)
//   bun run config get KEY [--raw]    one value (--raw: unmasked, default applied, for scripts)
//   bun run config set KEY VALUE      write a value (creates the file with mode 600)
//   bun run config unset KEY          remove a line (e.g. a setting a newer version dropped)
//   bun run config example            print .env.example, generated from src/server/settings.ts
//
// Used by the deploy scripts:
//   bun run config wrangler-config    write local/wrangler.json for this deployment
//   bun run config secrets-file       write local/.secrets.json (Worker secrets) and print its path
//   bun run config access-include     Cloudflare Access include rules (JSON)
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { directorySourceOf, isRequired, SETTINGS, settingByKey, type Setting } from "../src/server/settings";
import { parseValues } from "../src/shared/values";
import { cloudflareEnv, effective, ENV_FILE, fileValues, readEnvFile, ROOT, setValue, splitList } from "./lib/env";
import { readRosterFile } from "./lib/roster";

const mask = (s: Setting, v: string) => (s.secret && v ? `(set, ${v.length} characters)` : v);

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
  for (const key of seen.keys()) {
    if (!settingByKey.has(key)) warn(`${key} is not a known setting (typo, or dropped by a newer version) — bun run config unset ${key}`);
  }
  if (unreviewed.length) {
    section("Not in the config file yet (the default applies)");
    for (const s of unreviewed) console.log(`  • ${s.key} = ${s.default ? `"${s.default}"` : "(empty)"} — ${s.help}`);
    console.log("  → Review these with the operator and write each one, even to keep the default:");
    console.log("    bun run config set KEY VALUE   (then doctor stops listing it)");
  }

  section("Directory");
  if (directorySourceOf(env) === "roster") {
    const roster = readRosterFile(resolve(ROOT, effective(env, "ROSTER_FILE")));
    for (const e of roster.errors) fail(`roster: ${e}`);
    for (const w of roster.warnings) warn(`roster: ${w}`);
    if (!roster.errors.length) {
      const avatars = roster.entries.filter((e) => e.avatar).length;
      ok(`roster ${roster.file}: ${roster.entries.length} people, ${avatars} with avatars`);
      const emails = new Set(roster.entries.map((e) => e.email));
      for (const a of splitList(effective(env, "ADMIN_EMAILS"))) {
        if (!emails.has(a)) warn(`admin ${a} is not in the roster (can sign in, but can't be thanked)`);
      }
    }
  } else {
    ok(`Lark directory via ${effective(env, "LARK_BASE_URL")}, synced daily (${effective(env, "SYNC_CRON")} UTC)`);
  }

  if (effective(env, "EMAIL_NOTIFY") === "1") {
    section("Email");
    const from = effective(env, "EMAIL_FROM");
    if (from) {
      ok(`notification emails from ${from}`);
      console.log(`  · ${from.split("@")[1]} must be onboarded to Cloudflare Email Sending — scripts/cloudflare-setup.sh checks;`);
      console.log("    once deployed, the admin page can send you a test email");
    }
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

  section("Cloudflare");
  const cf = cloudflareEnv(env);
  if (!cf.exists) fail(`credentials file ${cf.file} is missing (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; see AGENTS.md)`);
  else {
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
      if (cf.creds[k]) ok(`${k} is set in ${cf.file}`);
      else fail(`${k} is missing from ${cf.file}`);
    }
    const mode = statSync(cf.file).mode & 0o777;
    if (mode & 0o077) warn(`${cf.file} is readable by others; chmod 600 it`);
  }
  if (existsSync(join(ROOT, "node_modules/.bin/wrangler"))) ok("wrangler is installed");
  else fail("wrangler is not installed — run bun install");

  console.log(failures ? `\n${failures} problem(s) to fix before deploying.` : "\nReady to deploy.");
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------- deploy helpers

function compatibilityDate() {
  const m = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  if (!m) throw new Error("compatibility_date not found in wrangler.jsonc");
  return m[1]!;
}

// The deployment's Wrangler config: same shape as the dev wrangler.jsonc, plus the real
// resources, the custom domain and the vars from .env.production.
function wranglerConfig() {
  const env = fileValues();
  const name = effective(env, "WORKER_NAME");
  const host = new URL(effective(env, "PUBLIC_URL")).host;
  const valuesFile = effective(env, "VALUES_FILE");
  const vars: Record<string, string> = {
    ENVIRONMENT: "production",
    APP_VERSION: Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT }).stdout.toString().trim(),
    VALUES_JSON: valuesFile ? JSON.stringify(parseValues(JSON.parse(readFileSync(resolve(ROOT, valuesFile), "utf8")))) : "",
  };
  for (const s of SETTINGS) {
    if (s.scope === "worker" && !s.secret && !s.devOnly && env[s.key] !== undefined) vars[s.key] = env[s.key]!;
  }
  const config = {
    $schema: "../node_modules/wrangler/config-schema.json",
    name,
    main: "../src/server/worker.ts",
    compatibility_date: compatibilityDate(),
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: host, custom_domain: true }],
    assets: {
      directory: "../dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/avatars/*", "/healthz"],
    },
    d1_databases: [{ binding: "DB", database_name: name, database_id: effective(env, "D1_DATABASE_ID"), migrations_dir: "../migrations" }],
    r2_buckets: [{ binding: "FILES", bucket_name: `${name}-files` }],
    // Cloudflare Email Service; only bound when notification emails are on.
    ...(effective(env, "EMAIL_NOTIFY") === "1" ? { send_email: [{ name: "EMAIL" }] } : {}),
    triggers: { crons: [effective(env, "SYNC_CRON")] },
    vars,
    observability: { enabled: true },
  };
  mkdirSync(join(ROOT, "local"), { recursive: true });
  const file = join(ROOT, "local/wrangler.json");
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log(file);
}

// Worker secrets for `wrangler deploy --secrets-file`; prints nothing when there are none.
function secretsFile() {
  const env = fileValues();
  const secrets = Object.fromEntries(SETTINGS.filter((s) => s.secret && env[s.key]).map((s) => [s.key, env[s.key]!]));
  if (!Object.keys(secrets).length) return;
  mkdirSync(join(ROOT, "local"), { recursive: true });
  const file = join(ROOT, "local/.secrets.json");
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  console.log(file);
}

function accessInclude() {
  const env = fileValues();
  const domains = new Set(splitList(effective(env, "ALLOWED_EMAIL_DOMAINS")));
  const rules: object[] = [...domains].map((domain) => ({ email_domain: { domain } }));
  const emails = new Set(splitList(effective(env, "ADMIN_EMAILS")));
  if (directorySourceOf(env) === "roster") {
    const roster = readRosterFile(resolve(ROOT, effective(env, "ROSTER_FILE")));
    if (roster.errors.length) throw new Error(`roster: ${roster.errors.join("; ")}`);
    for (const e of roster.entries) emails.add(e.email);
  }
  for (const email of emails) if (!domains.has(email.split("@")[1]!)) rules.push({ email: { email } });
  console.log(JSON.stringify(rules));
}

function example() {
  const groups: Record<Setting["group"], string> = {
    site: "Site",
    access: "Who can sign in",
    directory: "People directory",
    lark: "Lark / Feishu (DIRECTORY_SOURCE=lark)",
    notify: "Email notifications",
    app: "Thanks & Peer Bonus",
    cloudflare: "Cloudflare",
  };
  const out = [
    "# kuakua deployment settings. The deployed copy is .env.production (mode 600, never committed);",
    "# `bun run doctor` checks it and `bun run config set KEY VALUE` edits it. Generated from",
    "# src/server/settings.ts by `bun run config example` — edit that file, not this one.",
  ];
  for (const [group, title] of Object.entries(groups)) {
    out.push("", `# ---- ${title}`);
    for (const s of SETTINGS.filter((x) => x.group === group)) {
      const tags = [
        s.required === true ? "required" : typeof s.required === "function" ? "required when it applies" : null,
        s.secret ? "secret" : null,
        s.managed ? "set by scripts/cloudflare-setup.sh" : null,
      ]
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

// ---------------------------------------------------------------- commands

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
    const s = settingByKey.get(key);
    const v = effective(fileValues(), key);
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
  case "unset": {
    const key = args[0];
    if (!key) throw new Error("usage: config unset KEY");
    setValue(key, null);
    console.log(`${key} removed from ${ENV_FILE}`);
    break;
  }
  case "example":
    example();
    break;
  case "wrangler-config":
    wranglerConfig();
    break;
  case "secrets-file":
    secretsFile();
    break;
  case "access-include":
    accessInclude();
    break;
  default:
    console.log(readFileSync(import.meta.path, "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
    process.exit(cmd ? 1 : 0);
}
