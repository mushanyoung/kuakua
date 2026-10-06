// Local development: `bun run dev` → http://127.0.0.1:4381, signed in as the DEV_AUTH_EMAIL
// in wrangler.jsonc (an admin). Uses local D1/R2 under .wrangler/state; `bun run demo:seed`
// fills them with demo data. Rebuilds the web app on change; reload the page to see it.
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const run = (cmd: string[]) => Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });

const migrate = run(["bunx", "wrangler", "d1", "migrations", "apply", "kuakua", "--local"]);
if ((await migrate.exited) !== 0) process.exit(1);
const web = run(["bun", "scripts/build-web.ts", "--watch"]);
const worker = run(["bunx", "wrangler", "dev", "--port", "4381", "--ip", "127.0.0.1", "--test-scheduled"]);
const stop = () => (web.kill(), worker.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([web.exited, worker.exited]);
stop();
