// Every setting a deployment can put in .env.production, in one place: config.ts reads
// defaults from here, `bun run doctor` checks a deployment against it, `bun run config`
// edits it and generates .env.example from it. Adding a setting = add it here, read it
// in config.ts, then `bun run config example > .env.example`.
//
// Kept free of imports so scripts can load it without opening the database.

export type Setting = {
  key: string;
  group: "site" | "access" | "directory" | "lark" | "app" | "ops";
  /** Value used when the key is absent (as written in .env). */
  default?: string;
  /** Example shown in .env.example when there's no default. */
  example?: string;
  /** What it is and how to choose a value; shown by doctor and in .env.example. */
  help: string;
  /** Must be set in production. A function makes it depend on other settings. */
  required?: boolean | ((env: Record<string, string | undefined>) => boolean);
  /** Only relevant in some setups (e.g. one directory source); doctor skips it otherwise. */
  when?: (env: Record<string, string | undefined>) => boolean;
  secret?: boolean;
  /** Written by scripts/cloudflare-setup.sh rather than by hand. */
  managed?: boolean;
  /** Development only; must not appear in .env.production. */
  devOnly?: boolean;
  check?: (value: string, env: Record<string, string | undefined>) => string | null;
};

export const directorySourceOf = (env: Record<string, string | undefined>) =>
  (env.DIRECTORY_SOURCE || (env.LARK_APP_ID ? "lark" : "roster")).toLowerCase();
const isLark = (env: Record<string, string | undefined>) => directorySourceOf(env) === "lark";
const isRoster = (env: Record<string, string | undefined>) => directorySourceOf(env) === "roster";

const emailList = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    ? "expected comma-separated email addresses"
    : null;

const positiveInt = (v: string) => (/^\d+$/.test(v) && Number(v) > 0 ? null : "expected a positive whole number");

export const SETTINGS: Setting[] = [
  // ---- site
  {
    key: "PUBLIC_URL",
    group: "site",
    example: "https://kudos.example.com",
    required: true,
    help: "The site's public https address (no trailing slash). Its hostname is what scripts/cloudflare-setup.sh wires up.",
    check: (v) => (/^https:\/\/[^/]+$/.test(v) ? null : "expected https://host with no path"),
  },
  {
    key: "PORT",
    group: "site",
    default: "4380",
    help: "Local port the app listens on. Use a different one per deployment on the same machine.",
    check: positiveInt,
  },
  { key: "HOST", group: "site", default: "127.0.0.1", help: "Listen address. Keep 127.0.0.1: traffic arrives through the Cloudflare tunnel." },
  { key: "DATA_DIR", group: "site", default: "./data", help: "SQLite database, avatars and daily backups. Relative to the repo." },
  {
    key: "APP_TIMEZONE",
    group: "site",
    default: "Asia/Shanghai",
    help: "IANA time zone; the monthly Peer Bonus allowance resets at midnight on the 1st here.",
    check: (v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return null;
      } catch {
        return "unknown IANA time zone";
      }
    },
  },
  {
    key: "SERVICE_NAME",
    group: "ops",
    default: "kuakua",
    help: "systemd unit name used by scripts/deploy.sh. Use a different one per deployment on the same machine.",
    check: (v) => (/^[a-zA-Z0-9_.-]+$/.test(v) ? null : "letters, digits, . _ - only"),
  },

  // ---- access
  {
    key: "ADMIN_EMAILS",
    group: "access",
    example: "you@example.com",
    required: true,
    help: "Comma-separated admins: directory sync, Peer Bonus report, leaderboard, people page, deleting any post. Always allowed to sign in.",
    check: emailList,
  },
  {
    key: "ALLOWED_EMAIL_DOMAINS",
    group: "access",
    default: "",
    example: "example.com",
    help: "Comma-separated email domains whose people may sign in even if they're not in the directory. Leave empty to admit only the directory (and admins).",
  },
  {
    key: "CF_ACCESS_TEAM_DOMAIN",
    group: "access",
    example: "yourteam.cloudflareaccess.com",
    required: true,
    managed: true,
    help: "Cloudflare Zero Trust team domain. Written by scripts/cloudflare-setup.sh.",
  },
  {
    key: "CF_ACCESS_AUD",
    group: "access",
    required: true,
    managed: true,
    help: "AUD tag of the Cloudflare Access application. Written by scripts/cloudflare-setup.sh.",
  },
  {
    key: "CLOUDFLARE_ENV_FILE",
    group: "ops",
    default: ".env.cloudflare",
    help: "File with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (and optionally CLOUDFLARE_ZONE_ID, CLOUDFLARE_TUNNEL_ID) for scripts/cloudflare-setup.sh. Never read by the app.",
  },

  // ---- directory
  {
    key: "DIRECTORY_SOURCE",
    group: "directory",
    default: "",
    example: "roster",
    help: 'Where the people list comes from: "roster" (a CSV/JSON file, ROSTER_FILE) or "lark" (Lark contact sync). Empty = lark when LARK_APP_ID is set, else roster.',
    check: (v) => (!v || v === "lark" || v === "roster" ? null : 'expected "lark" or "roster"'),
  },
  {
    key: "ROSTER_FILE",
    group: "directory",
    default: "./local/roster.csv",
    when: isRoster,
    help: "Roster for DIRECTORY_SOURCE=roster: email,name,en_name,department,department_en,title,manager,avatar (see deploy/roster.example.csv). Avatar paths are relative to the file. Re-read automatically when it changes.",
  },
  {
    key: "LARK_APP_ID",
    group: "lark",
    default: "",
    required: isLark,
    when: isLark,
    help: "Lark/Feishu self-built app ID, for DIRECTORY_SOURCE=lark (directory sync and notifications). README lists the scopes it needs.",
  },
  { key: "LARK_APP_SECRET", group: "lark", default: "", required: isLark, when: isLark, secret: true, help: "Lark/Feishu app secret." },
  {
    key: "LARK_BASE_URL",
    group: "lark",
    default: "https://open.larksuite.com",
    when: isLark,
    help: "https://open.larksuite.com for Lark, https://open.feishu.cn for Feishu.",
  },
  { key: "LARK_SYNC_INTERVAL_HOURS", group: "lark", default: "6", when: isLark, help: "Hours between Lark directory syncs.", check: positiveInt },
  {
    key: "LARK_NOTIFY",
    group: "lark",
    default: "1",
    when: isLark,
    help: "1 = DM recipients, CC'd people and the sender on Lark (needs im:message:send_as_bot and the bot capability). 0 = off.",
    check: (v) => (v === "0" || v === "1" ? null : "expected 0 or 1"),
  },
  { key: "LARK_BROADCAST_CHAT_ID", group: "lark", default: "", when: isLark, help: "Optional Lark group chat ID that also gets every public thanks." },

  // ---- app
  {
    key: "VALUES_FILE",
    group: "app",
    default: "",
    example: "./local/values.json",
    help: "Optional JSON list of the values a thanks can be tagged with (see deploy/values.example.json). Empty = the built-in eight.",
  },
  { key: "BONUS_MONTHLY_ALLOWANCE", group: "app", default: "10", help: "Peer Bonus points each person can give per month.", check: positiveInt },
  { key: "BONUS_POINTS", group: "app", default: "1", help: "Points each recipient gets per Peer Bonus.", check: positiveInt },

  // ---- development
  {
    key: "DEV_AUTH_EMAIL",
    group: "ops",
    devOnly: true,
    help: "Local development only: sign everyone in as this email when there's no Cloudflare Access token.",
  },
];

export const settingByKey = new Map(SETTINGS.map((s) => [s.key, s]));

export const settingDefault = (key: string) => settingByKey.get(key)?.default ?? "";

export const isRequired = (s: Setting, env: Record<string, string | undefined>) =>
  typeof s.required === "function" ? s.required(env) : Boolean(s.required);
