import { config, larkEnabled } from "./config";
import { db } from "./db";
import { syncLark } from "./lark";
import { rosterObject, syncRoster } from "./roster";

// The people directory comes from one source per deployment (DIRECTORY_SOURCE): the Lark
// contact directory (synced daily by the cron trigger) or a roster file that
// scripts/deploy.sh uploads to R2 (synced whenever it changes).

export type SyncResult = { seen: number; active: number; avatarsUpdated: number; warnings: string[] };

const log = (...args: unknown[]) => console.log("[directory]", ...args);
const source = config.directory.source;
// A run that hasn't finished after this long was cut off (e.g. its Worker invocation ended);
// it's closed as failed so the admin page stops showing it as running.
const STALE_MS = 5 * 60_000;

async function closeStaleRuns() {
  await db.run(
    "UPDATE sync_runs SET finished_at = $now, ok = 0, error = 'interrupted' WHERE finished_at IS NULL AND started_at <= $stale",
    { now: Date.now(), stale: Date.now() - STALE_MS },
  );
}

export async function directoryConfigured() {
  return source === "lark" ? larkEnabled() : Boolean(await rosterObject());
}

export async function syncRunning() {
  await closeStaleRuns();
  return Boolean(
    await db.get("SELECT 1 AS running FROM sync_runs WHERE finished_at IS NULL AND started_at > $stale", { stale: Date.now() - STALE_MS }),
  );
}

// Runs a sync unless one is already running (returns null then). The run row doubles as
// the lock, so concurrent requests and the cron can't sync twice.
export async function syncDirectory(trigger: string): Promise<SyncResult | null> {
  const ref = source === "roster" ? ((await rosterObject())?.etag ?? null) : null;
  if (source === "lark" ? !larkEnabled() : !ref) {
    throw new Error(source === "lark" ? "LARK_APP_ID / LARK_APP_SECRET not configured" : "no roster uploaded yet");
  }
  await closeStaleRuns();
  const now = Date.now();
  const run = await db.get<{ id: number }>(
    `INSERT INTO sync_runs (trigger, started_at, source_ref)
     SELECT $trigger, $now, $ref WHERE NOT EXISTS (SELECT 1 FROM sync_runs WHERE finished_at IS NULL AND started_at > $stale)
     RETURNING id`,
    { trigger: `${source}/${trigger}`, now, ref, stale: now - STALE_MS },
  );
  if (!run) return null;
  try {
    const r = source === "lark" ? await syncLark() : await syncRoster();
    await db.run(
      `UPDATE sync_runs SET finished_at = $now, ok = 1, users_seen = $seen, users_active = $active,
         avatars_updated = $avatars, warnings = $warnings
       WHERE id = $id`,
      {
        now: Date.now(),
        seen: r.seen,
        active: r.active,
        avatars: r.avatarsUpdated,
        warnings: r.warnings.length ? JSON.stringify(r.warnings) : null,
        id: run.id,
      },
    );
    log(`${source} sync ok in ${((Date.now() - now) / 1000).toFixed(1)} s: ${r.seen} people (${r.active} active), ${r.avatarsUpdated} avatars updated`);
    for (const w of r.warnings) log("warning:", w);
    return r;
  } catch (e) {
    const message = (e as Error).message;
    await db.run("UPDATE sync_runs SET finished_at = $now, ok = 0, error = $error WHERE id = $id", {
      now: Date.now(),
      error: message,
      id: run.id,
    });
    log(`${source} sync failed:`, message);
    throw e;
  }
}

// Lark: once a day from the cron trigger. Roster: whenever the uploaded file's etag differs
// from the last run's (checked by the cron and, throttled, on page loads); a roster that
// failed isn't retried until it changes again.
export async function maybeSync(trigger: "schedule" | "request") {
  if (source === "lark") {
    if (trigger === "schedule" && larkEnabled()) await syncDirectory(trigger);
    return;
  }
  const roster = await rosterObject();
  if (!roster) return;
  const last = await db.get<{ source_ref: string | null }>(
    "SELECT source_ref FROM sync_runs WHERE trigger LIKE 'roster/%' ORDER BY id DESC LIMIT 1",
  );
  if (last?.source_ref === roster.etag) return;
  await syncDirectory(trigger);
}
