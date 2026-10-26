import { resolve } from "node:path";
import { localWorkerConfig } from "../../scripts/lib/local-wrangler.ts";

// The harness accepts Wrangler's legacy shape; derive it from the cf config.
const config = await localWorkerConfig();
export function testWorkerConfig(vars: Record<string, string> = {}, fixedClock = false) {
  return {
    ...config,
    main: resolve(fixedClock ? "tests/support/fixed-clock-worker.ts" : "src/server/worker.ts"),
    vars: { ...config.vars, ...vars },
  };
}
