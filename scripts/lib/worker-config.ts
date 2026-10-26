import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bindings, triggers, type WorkerConfig } from "cf/config";
import { SETTINGS } from "../../src/server/settings.ts";
import { parseValues } from "../../src/shared/values.ts";
import { effective, ROOT } from "./env.ts";

export const LOCAL_DATABASE_ID = "local-dev";
export const LOCAL_BUCKET = "kuakua-files";
export const LOCAL_STATE = ".wrangler/state";
export const MIGRATIONS_DIR = "migrations";

// Deployment values and defaults come from settings.ts; only the demo identity is local.
export function createWorkerConfig(production?: Record<string, string>) {
  const local = production === undefined;
  const values = production ?? {
    PUBLIC_URL: "http://127.0.0.1:4381",
    DEV_AUTH_EMAIL: "mushan@example.com",
    ADMIN_EMAILS: "mushan@example.com",
    ALLOWED_EMAIL_DOMAINS: "example.com",
    DIRECTORY_SOURCE: "roster",
    EMAIL_NOTIFY: "1",
    EMAIL_FROM: "kudos@notify.example.com",
  };
  if (!local && !effective(values, "D1_DATABASE_ID")) throw new Error("D1_DATABASE_ID is required for production");
  const name = local ? "kuakua-dev" : effective(values, "WORKER_NAME");
  const valuesFile = local ? "" : effective(values, "VALUES_FILE");
  const env: NonNullable<WorkerConfig["env"]> = {};
  for (const setting of SETTINGS) {
    if (setting.scope !== "worker" || (!local && setting.devOnly)) continue;
    if (setting.secret) {
      if (!local && values[setting.key]) env[setting.key] = bindings.secret();
    } else {
      // Preserve empty deployment values: the Worker applies settings defaults itself.
      env[setting.key] = bindings.text(values[setting.key] ?? setting.default ?? "");
    }
  }
  return {
    name,
    entrypoint: "src/server/worker.ts",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    ...(local ? {} : { workersDev: false, previewUrls: false, domains: [new URL(effective(values, "PUBLIC_URL")).hostname] }),
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*", "/avatars/*"] },
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: effective(values, "SYNC_CRON") })],
    env: {
      ...env,
      ENVIRONMENT: bindings.text(local ? "development" : "production"),
      VALUES_JSON: bindings.text(
        valuesFile ? JSON.stringify(parseValues(JSON.parse(readFileSync(resolve(ROOT, valuesFile), "utf8")))) : "",
      ),
      DB: bindings.d1({ name: local ? "kuakua" : name, id: local ? LOCAL_DATABASE_ID : effective(values, "D1_DATABASE_ID") }),
      FILES: bindings.r2({ name: local ? LOCAL_BUCKET : `${name}-files` }),
      ...(effective(values, "EMAIL_NOTIFY") === "1" ? { EMAIL: bindings.sendEmail({}) } : {}),
      ASSETS: bindings.assets(),
    },
  } satisfies WorkerConfig;
}
