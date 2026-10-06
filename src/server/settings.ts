// Every setting a deployment can put in .env.production, in one place: config.ts reads
// defaults from here, `bun run doctor` checks a deployment against it, `bun run config`
// edits it and generates .env.example from it, and scripts/deploy.sh turns the "worker"
// ones into the Worker's vars (secrets into Worker secrets). Adding a setting = add it here,
// read it in config.ts (if the Worker needs it), then `bun run config example > .env.example`.
//
// Kept free of imports so local scripts can load it too.

export type Setting = {
  key: string;
  group: "site" | "access" | "directory" | "lark" | "notify" | "app" | "cloudflare";
  /** "worker": passed to the Worker. "deploy": only used by the deploy scripts. */
  scope: "worker" | "deploy";
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
const emailOn = (env: Record<string, string | undefined>) => env.EMAIL_NOTIFY === "1";
const isEmail = (v: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "expected an email address");

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
    scope: "worker",
    example: "https://kudos.example.com",
    required: true,
    help: "The site's public https address (no trailing slash). The Worker is attached to this hostname as a Custom Domain; its zone must be in the Cloudflare account.",
    check: (v) => (/^https:\/\/[^/]+$/.test(v) ? null : "expected https://host with no path"),
  },
  {
    key: "APP_TIMEZONE",
    group: "site",
    scope: "worker",
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

  // ---- access
  {
    key: "ADMIN_EMAILS",
    group: "access",
    scope: "worker",
    example: "you@example.com",
    required: true,
    help: "Comma-separated admins: directory sync, Peer Bonus report, leaderboard, people page, deleting any post. Always allowed to sign in.",
    check: emailList,
  },
  {
    key: "ALLOWED_EMAIL_DOMAINS",
    group: "access",
    scope: "worker",
    default: "",
    example: "example.com",
    help: "Comma-separated email domains whose people may sign in even if they're not in the directory. Leave empty to admit only the directory (and admins).",
  },
  {
    key: "CF_ACCESS_TEAM_DOMAIN",
    group: "access",
    scope: "worker",
    example: "yourteam.cloudflareaccess.com",
    required: true,
    managed: true,
    help: "Cloudflare Zero Trust team domain. Written by scripts/cloudflare-setup.sh.",
  },
  {
    key: "CF_ACCESS_AUD",
    group: "access",
    scope: "worker",
    required: true,
    managed: true,
    help: "AUD tag of the Cloudflare Access application. Written by scripts/cloudflare-setup.sh.",
  },

  // ---- directory
  {
    key: "DIRECTORY_SOURCE",
    group: "directory",
    scope: "worker",
    default: "",
    example: "roster",
    help: 'Where the people list comes from: "roster" (a CSV/JSON file, ROSTER_FILE) or "lark" (Lark contact sync). Empty = lark when LARK_APP_ID is set, else roster.',
    check: (v) => (!v || v === "lark" || v === "roster" ? null : 'expected "lark" or "roster"'),
  },
  {
    key: "ROSTER_FILE",
    group: "directory",
    scope: "deploy",
    default: "./local/roster.csv",
    when: isRoster,
    help: "Roster for DIRECTORY_SOURCE=roster: email,name,en_name,department,department_en,title,manager,avatar (see deploy/roster.example.csv). Avatar paths are relative to the file. scripts/deploy.sh uploads it with its avatars; the site picks up a changed roster within a minute.",
  },
  {
    key: "SYNC_CRON",
    group: "directory",
    scope: "deploy",
    default: "0 19 * * *",
    help: "When the daily directory sync runs, as a cron expression in UTC (default 19:00 UTC = 03:00 in China). Lark avatars are only downloaded when they changed.",
  },
  {
    key: "LARK_APP_ID",
    group: "lark",
    scope: "worker",
    default: "",
    required: isLark,
    when: isLark,
    help: "Lark/Feishu self-built app ID, for DIRECTORY_SOURCE=lark (directory sync and notifications). README lists the scopes it needs.",
  },
  {
    key: "LARK_APP_SECRET",
    group: "lark",
    scope: "worker",
    default: "",
    required: isLark,
    when: isLark,
    secret: true,
    help: "Lark/Feishu app secret (stored as a Worker secret).",
  },
  {
    key: "LARK_BASE_URL",
    group: "lark",
    scope: "worker",
    default: "https://open.larksuite.com",
    when: isLark,
    help: "https://open.larksuite.com for Lark, https://open.feishu.cn for Feishu.",
  },
  {
    key: "LARK_NOTIFY",
    group: "lark",
    scope: "worker",
    default: "1",
    when: isLark,
    help: "1 = DM recipients, CC'd people and the sender on Lark (needs im:message:send_as_bot and the bot capability). 0 = off.",
    check: (v) => (v === "0" || v === "1" ? null : "expected 0 or 1"),
  },
  {
    key: "LARK_BROADCAST_CHAT_ID",
    group: "lark",
    scope: "worker",
    default: "",
    when: isLark,
    help: "Optional Lark group chat ID that also gets every public thanks.",
  },

  // ---- notify
  {
    key: "EMAIL_NOTIFY",
    group: "notify",
    scope: "worker",
    default: "0",
    help: "1 = email the people thanked and CC'd (works with either directory). Sent through Cloudflare Email Service from EMAIL_FROM, whose domain must be onboarded to Email Sending (see AGENTS.md). 0 = off.",
    check: (v) => (v === "0" || v === "1" ? null : "expected 0 or 1"),
  },
  {
    key: "EMAIL_FROM",
    group: "notify",
    scope: "worker",
    default: "",
    example: "kudos@example.com",
    required: emailOn,
    when: emailOn,
    help: "Sender address for notification emails, e.g. kudos@example.com. Its domain must be onboarded to Cloudflare Email Sending (see AGENTS.md); replies go to the person who sent the thanks.",
    check: isEmail,
  },
  {
    key: "EMAIL_FROM_NAME",
    group: "notify",
    scope: "worker",
    default: "夸夸",
    when: emailOn,
    help: "Sender name shown in notification emails.",
  },

  // ---- app
  {
    key: "VALUES_FILE",
    group: "app",
    scope: "deploy",
    default: "",
    example: "./local/values.json",
    help: "Optional JSON list of the values a thanks can be tagged with (see deploy/values.example.json); scripts/deploy.sh passes it to the Worker. Empty = the built-in eight.",
  },
  { key: "BONUS_MONTHLY_ALLOWANCE", group: "app", scope: "worker", default: "10", help: "Peer Bonus points each person can give per month.", check: positiveInt },
  { key: "BONUS_POINTS", group: "app", scope: "worker", default: "1", help: "Points each recipient gets per Peer Bonus.", check: positiveInt },

  // ---- cloudflare
  {
    key: "WORKER_NAME",
    group: "cloudflare",
    scope: "deploy",
    default: "kuakua",
    help: "Name of the Worker; the D1 database and R2 bucket are named after it. Use a different one per deployment in the same Cloudflare account.",
    check: (v) => (/^[a-z0-9][a-z0-9-]{0,50}$/.test(v) ? null : "lowercase letters, digits and - only"),
  },
  {
    key: "DATA_LOCATION",
    group: "cloudflare",
    scope: "deploy",
    default: "",
    example: "apac",
    help: "Where scripts/cloudflare-setup.sh creates the D1 database and R2 bucket: wnam, enam, weur, eeur, apac or oc (apac for users in Asia). Empty = near whoever runs the script. Only applies when they're first created.",
    check: (v) => (!v || ["wnam", "enam", "weur", "eeur", "apac", "oc"].includes(v) ? null : "expected wnam, enam, weur, eeur, apac or oc"),
  },
  {
    key: "D1_DATABASE_ID",
    group: "cloudflare",
    scope: "deploy",
    required: true,
    managed: true,
    help: "ID of the D1 database. Written by scripts/cloudflare-setup.sh.",
  },
  {
    key: "CLOUDFLARE_ENV_FILE",
    group: "cloudflare",
    scope: "deploy",
    default: ".env.cloudflare",
    help: "File with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for the deploy scripts. Never sent to the Worker.",
  },

  // ---- development
  {
    key: "DEV_AUTH_EMAIL",
    group: "access",
    scope: "worker",
    devOnly: true,
    help: "Local development only: sign everyone in as this email when there's no Cloudflare Access token.",
  },
];

export const settingByKey = new Map(SETTINGS.map((s) => [s.key, s]));

export const isRequired = (s: Setting, env: Record<string, string | undefined>) =>
  typeof s.required === "function" ? s.required(env) : Boolean(s.required);
