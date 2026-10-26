// Local D1/R2 only. `pnpm run demo:seed` supplies optional demo data.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

import { applyLocalMigrations } from "./lib/local-d1.ts";

const cwd = resolve(import.meta.dirname, "..");
applyLocalMigrations();
if (spawnSync("pnpm", ["run", "build:web"], { cwd, stdio: "inherit" }).status !== 0) process.exit(1);
const web = spawn(process.execPath, ["scripts/build-web.ts", "--watch"], { cwd, stdio: "inherit" });
const worker = spawn("pnpm", ["exec", "cf", "dev", "--mode", "development"], {
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
