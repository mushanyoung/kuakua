import { existsSync, statSync } from "node:fs";
import { config, larkEnabled } from "./config";
import { db } from "./db";
import { syncLark } from "./lark";
import { syncRoster } from "./roster";

// The people directory comes from one source per deployment (DIRECTORY_SOURCE):
// the Lark contact directory, or a roster file kept next to the app.

export type SyncResult = { seen: number; active: number; avatarsUpdated: number; warnings: string[] };

const log = (...args: unknown[]) => console.log("[directory]", ...args);
const source = config.directory.source;

export function directoryConfigured() {
  return source === "lark" ? larkEnabled() : existsSync(config.directory.rosterFile);
}

let running: Promise<SyncResult> | null = null;
export const syncRunning = () => running !== null;

export function syncDirectory(trigger: string) {
  if (!directoryConfigured()) {
    const why = source === "lark" ? "LARK_APP_ID / LARK_APP_SECRET not configured" : `roster file not found: ${config.directory.rosterFile}`;
    return Promise.reject(new Error(why));
  }
  running ??= run(trigger).finally(() => (running = null));
  return running;
}

async function run(trigger: string) {
  const res = db
    .query("INSERT INTO sync_runs (trigger, started_at) VALUES ($trigger, $now)")
    .run({ trigger: `${source}/${trigger}`, now: Date.now() });
  const id = Number(res.lastInsertRowid);
  try {
    const r = source === "lark" ? await syncLark() : await syncRoster();
    db.query(
      `UPDATE sync_runs SET finished_at = $now, ok = 1, users_seen = $seen, users_active = $active,
         avatars_updated = $avatars, warnings = $warnings
       WHERE id = $id`,
    ).run({
      now: Date.now(),
      seen: r.seen,
      active: r.active,
      avatars: r.avatarsUpdated,
      warnings: r.warnings.length ? JSON.stringify(r.warnings) : null,
      id,
    });
    log(`${source} sync ok: ${r.seen} people (${r.active} active), ${r.avatarsUpdated} avatars updated`);
    for (const w of r.warnings) log("warning:", w);
    return r;
  } catch (e) {
    const message = (e as Error).message;
    db.query("UPDATE sync_runs SET finished_at = $now, ok = 0, error = $error WHERE id = $id").run({ now: Date.now(), error: message, id });
    log(`${source} sync failed:`, message);
    throw e;
  }
}

function lastRun(okOnly: boolean) {
  return db
    .query(`SELECT ok, started_at, finished_at FROM sync_runs WHERE trigger LIKE $prefix ${okOnly ? "AND ok = 1" : ""} ORDER BY id DESC LIMIT 1`)
    .get({ prefix: `${source}/%` }) as { ok: number | null; started_at: number; finished_at: number | null } | null;
}

// Runs on startup and every minute: Lark every LARK_SYNC_INTERVAL_HOURS, the roster
// whenever its file changes. A failed run is retried after 30 minutes (Lark) or once
// the file changes again (roster).
export function maybeSync() {
  if (running || !directoryConfigured()) return;
  const last = lastRun(false);
  const lastOk = lastRun(true)?.finished_at ?? 0;
  if (source === "lark") {
    if (last && !last.ok && Date.now() - last.started_at < 30 * 60_000) return;
    if (Date.now() - lastOk < config.lark.syncIntervalHours * 3600_000) return;
  } else {
    const changed = statSync(config.directory.rosterFile).mtimeMs;
    if (last && !last.ok && last.started_at > changed) return;
    if (lastOk > changed) return;
  }
  syncDirectory("schedule").catch(() => {});
}
