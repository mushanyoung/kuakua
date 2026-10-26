// Local D1/R2 only. `pnpm run demo:seed` supplies optional demo data.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

import { writeLocalWranglerConfig } from "./lib/local-wrangler.ts";
import { LOCAL_STATE } from "./lib/worker-config.ts";

const cwd = resolve(import.meta.dirname, "..");
const config = await writeLocalWranglerConfig();
for (const args of [
  ["exec", "wrangler", "d1", "migrations", "apply", "DB", "-c", config, "--local", "--persist-to", LOCAL_STATE],
  ["run", "build:web"],
]) {
  if (spawnSync("pnpm", args, { cwd, stdio: "inherit" }).status !== 0) process.exit(1);
}
const web = spawn(process.execPath, ["scripts/build-web.ts", "--watch"], { cwd, stdio: "inherit" });
const worker = spawn("pnpm", ["exec", "cf", "dev"], {
  cwd,
  stdio: "inherit",
});
const stop = () => {
  web.kill();
  worker.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const [code] = await Promise.race([once(web, "exit"), once(worker, "exit")]);
  process.exitCode = typeof code === "number" ? code : 1;
} finally {
  stop();
}
