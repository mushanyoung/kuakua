import { env } from "cloudflare:workers";
import { directorySourceOf, settingByKey } from "./settings";
import { parseValues, setValues } from "../shared/values";

// Every deployment-specific setting comes from the Worker's vars and secrets, which
// scripts/deploy.sh generates from .env.production. settings.ts lists them with their
// defaults; `bun run doctor` checks them.

const vars: Record<string, unknown> = Object.fromEntries(Object.entries(env));

// Only settings declared in settings.ts can be read, so none goes undocumented.
function get(key: string) {
  const setting = settingByKey.get(key);
  if (!setting) throw new Error(`setting ${key} is not declared in settings.ts`);
  const v = vars[key];
  return typeof v === "string" && v !== "" ? v : (setting.default ?? "");
}

// Vars that scripts/deploy.sh derives rather than copies from .env.production.
const derived = (key: "ENVIRONMENT" | "VALUES_JSON") => {
  const v = vars[key];
  return typeof v === "string" ? v : "";
};

const list = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const num = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? n : fallback;
};

export type DirectorySource = "lark" | "roster";

const directorySource = directorySourceOf({ DIRECTORY_SOURCE: get("DIRECTORY_SOURCE"), LARK_APP_ID: get("LARK_APP_ID") });
if (directorySource !== "lark" && directorySource !== "roster") {
  throw new Error(`DIRECTORY_SOURCE must be "lark" or "roster", got "${directorySource}"`);
}

export const config = {
  production: derived("ENVIRONMENT") === "production",
  publicUrl: get("PUBLIC_URL").replace(/\/$/, ""),
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

  directory: { source: directorySource as DirectorySource },

  email: {
    notify: get("EMAIL_NOTIFY") === "1",
    from: get("EMAIL_FROM"),
    fromName: get("EMAIL_FROM_NAME"),
  },

  lark: {
    appId: get("LARK_APP_ID"),
    appSecret: get("LARK_APP_SECRET"),
    baseUrl: get("LARK_BASE_URL").replace(/\/$/, ""),
    notify: get("LARK_NOTIFY") !== "0",
    broadcastChatId: get("LARK_BROADCAST_CHAT_ID"),
  },

  bonus: {
    monthlyAllowance: num(get("BONUS_MONTHLY_ALLOWANCE"), 10),
    // Fixed points per recipient; the sender doesn't choose an amount.
    points: Math.max(1, Math.floor(num(get("BONUS_POINTS"), 1))),
  },
};

// VALUES_FILE is read at deploy time and passed in as JSON.
if (derived("VALUES_JSON")) setValues(parseValues(JSON.parse(derived("VALUES_JSON"))));

export const ADMIN_EMAILS: ReadonlySet<string> = new Set(config.adminEmails);

export const larkEnabled = () => Boolean(config.lark.appId && config.lark.appSecret);

// Lark DMs go to people by their Lark open_id, which only the Lark directory sync knows.
export const larkNotifyEnabled = () => larkEnabled() && config.lark.notify && config.directory.source === "lark";

// The EMAIL binding (send_email) is only in the Worker's config when EMAIL_NOTIFY=1.
export const emailNotifyEnabled = () => config.email.notify && Boolean(config.email.from) && "EMAIL" in env;

// Channels that reach people one to one, for the "they'll be notified" hints in the UI.
export const notifyChannels = () => [...(larkNotifyEnabled() ? ["lark"] : []), ...(emailNotifyEnabled() ? ["email"] : [])];

// Domain-level check; store.canSignIn() also admits everyone in the directory.
export function isAllowedEmail(email: string) {
  email = email.toLowerCase();
  const domain = email.split("@")[1];
  return Boolean(domain && (config.allowedDomains.includes(domain) || ADMIN_EMAILS.has(email)));
}
