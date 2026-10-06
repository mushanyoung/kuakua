// Reading and writing the deployment's .env.production (or $ENV_FILE), shared by the scripts.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { settingByKey } from "../../src/server/settings";

export const ROOT = resolve(import.meta.dir, "../..");
export const ENV_FILE = resolve(ROOT, process.env.ENV_FILE ?? ".env.production");

export type Line = { key: string; value: string } | { raw: string };

function parseValue(v: string) {
  v = v.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.startsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : v.slice(1, -1);
  }
  return v;
}

export function readEnvFile(file = ENV_FILE): Line[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((raw) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
      return m ? { key: m[1]!, value: parseValue(m[2]!) } : { raw };
    });
}

export const fileValues = (lines = readEnvFile()) =>
  Object.fromEntries(lines.flatMap((l) => ("key" in l ? [[l.key, l.value] as const] : []))) as Record<string, string>;

export const formatValue = (v: string) => (/^[^\s"'#\\$`]*$/.test(v) ? v : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

// Writes KEY=VALUE (or removes KEY when value is null), keeping every other line as it was.
export function setValue(key: string, value: string | null, file = ENV_FILE) {
  const lines = readEnvFile(file);
  let done = false;
  const out = lines.flatMap((l) => {
    if (!("key" in l) || l.key !== key) return ["key" in l ? `${l.key}=${formatValue(l.value)}` : l.raw];
    if (done || value === null) return [];
    done = true;
    return [`${key}=${formatValue(value)}`];
  });
  if (!done && value !== null) {
    while (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${formatValue(value)}`);
  }
  writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  chmodSync(file, 0o600);
}

// The value in the file, else the setting's default.
export const effective = (env: Record<string, string>, key: string) => env[key] || settingByKey.get(key)?.default || "";

export const splitList = (v: string) =>
  v
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Cloudflare credentials for wrangler, from CLOUDFLARE_ENV_FILE (never from .env.production).
export function cloudflareEnv(env = fileValues()) {
  const file = resolve(ROOT, process.env.CLOUDFLARE_ENV_FILE || effective(env, "CLOUDFLARE_ENV_FILE"));
  const creds = existsSync(file) ? fileValues(readEnvFile(file)) : {};
  return { file, exists: existsSync(file), creds };
}
