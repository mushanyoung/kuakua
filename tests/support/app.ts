import { createTestHarness } from "wrangler";

import { testWorkerConfig } from "./config.ts";

const testVars = {
  DEV_AUTH_EMAIL: "alice@example.com",
  ADMIN_EMAILS: "admin@example.com",
  ALLOWED_EMAIL_DOMAINS: "",
  DIRECTORY_SOURCE: "roster",
  EMAIL_NOTIFY: "0",
  LARK_NOTIFY: "0",
  APP_TIMEZONE: "UTC",
  BONUS_MONTHLY_ALLOWANCE: "2",
  BONUS_POINTS: "1",
};

export async function createApp(fixedClock = false) {
  const server = createTestHarness({ workers: [{ config: testWorkerConfig(testVars, fixedClock) }] });
  try {
    const { url } = await server.listen();
    const worker = server.getWorker<Env>();
    await worker.applyD1Migrations("DB");
    const env = await worker.getEnv();
    return { server, worker, env, url: url.href };
  } catch (error) {
    await server.close();
    throw error;
  }
}
export type App = Awaited<ReturnType<typeof createApp>>;

export async function resetApp({ env, server }: App) {
  server.clearLogs();
  await env.DB.batch([env.DB.prepare("DELETE FROM posts"), env.DB.prepare("DELETE FROM users"), env.DB.prepare("DELETE FROM sync_runs")]);
  await env.DB.prepare(`INSERT INTO users (id, email, name, active, source, created_at, updated_at)
    SELECT CAST(key AS INTEGER) + 1, value || '@example.com', value, value <> 'inactive', 'roster', 1, 1 FROM json_each(?1)`)
    .bind(JSON.stringify(["admin", "alice", "bob", "carol", "outsider", "inactive"]))
    .run();
  const objects = (await env.FILES.list()).objects;
  if (objects.length) await env.FILES.delete(objects.map(({ key }) => key));
}

export function request(app: App, path: string, method = "GET", body?: unknown, user = "alice") {
  return app.worker.fetch(path, {
    method,
    headers: { "X-Dev-Email": `${user}@example.com`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
