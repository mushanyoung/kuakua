import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const group = process.argv[2];
if (group !== "unit" && group !== "integration") throw new Error("Expected unit or integration");
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
    group === "unit" ? "tests/unit/*.test.ts" : "tests/*.test.ts",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
