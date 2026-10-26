// Apply the same opt-out to tool subprocesses and local runtime telemetry.
process.env.DO_NOT_TRACK = "1";
process.env.CF_SEND_TELEMETRY = "false";
process.env.WRANGLER_SEND_METRICS = "false";
