import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const group = process.argv[2];
if (group !== "unit" && group !== "integration" && group !== "cli") throw new Error("Expected unit, integration or cli");
mkdirSync("test-results", { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-timeout=30000",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=test-results/${group}.xml`,
    group === "integration" ? "tests/*.test.ts" : `tests/${group}/*.test.ts`,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
