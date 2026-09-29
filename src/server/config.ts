import { resolve } from "node:path";

const env = process.env;

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : fallback;
};

export const config = {
  production: env.NODE_ENV === "production",
  host: env.HOST ?? "127.0.0.1",
  port: num(env.PORT, 4380),
  dataDir: resolve(env.DATA_DIR ?? "./data"),
  publicUrl: (env.PUBLIC_URL ?? "https://kuakua.maxinsights.ai").replace(/\/$/, ""),
  timezone: env.APP_TIMEZONE ?? "Asia/Shanghai",

  access: {
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN ?? "",
    aud: env.CF_ACCESS_AUD ?? "",
    // Local development only: trusted identity when no Access JWT is present.
    devEmail: env.DEV_AUTH_EMAIL?.toLowerCase() ?? "",
  },
  allowedDomains: list(env.ALLOWED_EMAIL_DOMAINS ?? "maxinsights.ai"),

  lark: {
    appId: env.LARK_APP_ID ?? "",
    appSecret: env.LARK_APP_SECRET ?? "",
    baseUrl: (env.LARK_BASE_URL ?? "https://open.larksuite.com").replace(/\/$/, ""),
    syncIntervalHours: num(env.LARK_SYNC_INTERVAL_HOURS, 6),
    notify: env.LARK_NOTIFY !== "0",
    broadcastChatId: env.LARK_BROADCAST_CHAT_ID ?? "",
  },

  bonus: {
    monthlyAllowance: num(env.BONUS_MONTHLY_ALLOWANCE, 100),
    amounts: (env.BONUS_AMOUNTS ?? "10,20,50")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  },
};

// Deliberately hard-coded: admin (sync, bonus report, leaderboard, people directory, moderation).
export const ADMIN_EMAILS: ReadonlySet<string> = new Set(["mushan@maxinsights.ai"]);

export const larkEnabled = () => Boolean(config.lark.appId && config.lark.appSecret);

export function isAllowedEmail(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  return Boolean(domain && config.allowedDomains.includes(domain));
}
