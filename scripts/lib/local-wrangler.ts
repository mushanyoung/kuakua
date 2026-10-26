import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertToWranglerConfig, resolveAndParseConfig } from "@cloudflare/config";
import type { Unstable_RawConfig } from "wrangler";
import { ROOT } from "./env.ts";
import { createWorkerConfig, MIGRATIONS_DIR } from "./worker-config.ts";

// cf's D1 CLI requires UUIDs even locally. Keep the existing local-dev database
// identity by using Wrangler for local D1 operations, with config derived from cf.
export async function localWorkerConfig(): Promise<Omit<Unstable_RawConfig, "env">> {
  const parsed = await resolveAndParseConfig({ worker: createWorkerConfig() }, { mode: "development", isPreview: false });
  if (!parsed.success) throw parsed.error;
  const config: Omit<Unstable_RawConfig, "env"> = convertToWranglerConfig(parsed.data);
  return {
    ...config,
    main: resolve(ROOT, "src/server/worker.ts"),
    assets: { ...config.assets, directory: resolve(ROOT, "dist") },
    d1_databases: config.d1_databases?.map((db) => ({ ...db, migrations_dir: resolve(ROOT, MIGRATIONS_DIR) })),
  };
}

export async function writeLocalWranglerConfig() {
  const file = join(ROOT, ".wrangler/local.json");
  mkdirSync(join(ROOT, ".wrangler"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(await localWorkerConfig(), null, 2)}\n`);
  return file;
}
