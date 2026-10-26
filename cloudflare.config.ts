import { defineConfig } from "cf/config";
import { fileValues } from "./scripts/lib/env.ts";
import { createWorkerConfig } from "./scripts/lib/worker-config.ts";

// Only the explicit production mode reads deployment-local settings.
export default defineConfig(({ mode }) => {
  if (mode !== undefined && mode !== "development" && mode !== "production") throw new Error(`Unknown mode: ${mode}`);
  return { worker: createWorkerConfig(mode === "production" ? fileValues() : undefined) };
});
