import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { directorySourceOf, settingByKey } from "./settings";
import { parseValues, setValues } from "../shared/values";

// Every deployment-specific setting comes from the environment (.env.production in
// production). settings.ts lists them with their defaults; `bun run doctor` checks them.

const env = process.env;

// Only settings declared in settings.ts can be read, so none goes undocumented.
function get(key: string) {
  const setting = settingByKey.get(key);
  if (!setting) throw new Error(`setting ${key} is not declared in settings.ts`);
  const v = env[key];
  return v === undefined || v === "" ? (setting.default ?? "") : v;
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : fallback;
};

export type DirectorySource = "lark" | "roster";

const directorySource = directorySourceOf({ DIRECTORY_SOURCE: get("DIRECTORY_SOURCE"), LARK_APP_ID: get("LARK_APP_ID") });
if (directorySource !== "lark" && directorySource !== "roster") {
  throw new Error(`DIRECTORY_SOURCE must be "lark" or "roster", got "${directorySource}"`);
}

const port = num(get("PORT"), 4380);

export const config = {
  production: env.NODE_ENV === "production",
  host: get("HOST"),
  port,
  dataDir: resolve(get("DATA_DIR")),
  publicUrl: (get("PUBLIC_URL") || `http://127.0.0.1:${port}`).replace(/\/$/, ""),
  timezone: get("APP_TIMEZONE"),

  // Admin: directory sync, bonus report, leaderboard, people directory, moderation.
  adminEmails: list(get("ADMIN_EMAILS")),

  access: {
    teamDomain: get("CF_ACCESS_TEAM_DOMAIN"),
    aud: get("CF_ACCESS_AUD"),
    // Local development only: trusted identity when no Access JWT is present.
    devEmail: get("DEV_AUTH_EMAIL").toLowerCase(),
  },
  // Anyone with an email at these domains may sign in, on top of everyone in the directory.
  allowedDomains: list(get("ALLOWED_EMAIL_DOMAINS")),

  directory: {
    source: directorySource as DirectorySource,
    rosterFile: resolve(get("ROSTER_FILE")),
  },
  valuesFile: get("VALUES_FILE") ? resolve(get("VALUES_FILE")) : null,

  lark: {
    appId: get("LARK_APP_ID"),
    appSecret: get("LARK_APP_SECRET"),
    baseUrl: get("LARK_BASE_URL").replace(/\/$/, ""),
    syncIntervalHours: num(get("LARK_SYNC_INTERVAL_HOURS"), 6),
    notify: get("LARK_NOTIFY") !== "0",
    broadcastChatId: get("LARK_BROADCAST_CHAT_ID"),
  },

  bonus: {
    monthlyAllowance: num(get("BONUS_MONTHLY_ALLOWANCE"), 10),
    // Fixed points per recipient; the sender doesn't choose an amount.
    points: Math.max(1, Math.floor(num(get("BONUS_POINTS"), 1))),
  },
};

if (config.valuesFile) {
  try {
    setValues(parseValues(JSON.parse(readFileSync(config.valuesFile, "utf8"))));
  } catch (e) {
    throw new Error(`VALUES_FILE ${config.valuesFile}: ${(e as Error).message}`);
  }
}

export const ADMIN_EMAILS: ReadonlySet<string> = new Set(config.adminEmails);

export const larkEnabled = () => Boolean(config.lark.appId && config.lark.appSecret);

// Lark DMs go to people by their Lark open_id, which only the Lark directory sync knows.
export const larkNotifyEnabled = () => larkEnabled() && config.lark.notify && config.directory.source === "lark";

// Domain-level check; store.canSignIn() also admits everyone in the directory.
export function isAllowedEmail(email: string) {
  email = email.toLowerCase();
  const domain = email.split("@")[1];
  return Boolean(domain && (config.allowedDomains.includes(domain) || ADMIN_EMAILS.has(email)));
}
