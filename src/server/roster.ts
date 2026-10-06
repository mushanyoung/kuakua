import { existsSync } from "node:fs";
import { avatarFile, sniff, writeAvatar } from "./avatars";
import { config } from "./config";
import { db } from "./db";
import type { SyncResult } from "./directory";
import { readRoster, type RosterEntry } from "./roster-file";

const deptId = (name: string) => `roster:${name}`;

// Mirrors ROSTER_FILE into users/departments. People who drop out of the file are
// deactivated (their history stays); a file with any error changes nothing.
export async function syncRoster(): Promise<SyncResult> {
  const { entries, errors, warnings } = readRoster(config.directory.rosterFile);
  if (errors.length) throw new Error(errors.join("; "));
  const now = Date.now();

  type Existing = { id: number; avatar_src: string | null; avatar_ver: string | null };
  const jobs: { row: Existing; entry: RosterEntry }[] = [];

  db.transaction(() => {
    const depts = new Map<string, string | null>();
    for (const e of entries) if (e.department && !depts.get(e.department)) depts.set(e.department, e.departmentEn);
    const upDept = db.query(
      `INSERT INTO departments (id, name, en_name, parent_id, updated_at) VALUES ($id, $name, $en, NULL, $now)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, en_name = excluded.en_name, updated_at = excluded.updated_at`,
    );
    for (const [name, en] of depts) upDept.run({ id: deptId(name), name, en, now });

    const byEmail = db.query("SELECT id, avatar_src, avatar_ver FROM users WHERE email = $email");
    const update = db.query(
      `UPDATE users SET name = $name, en_name = $en, dept_id = $dept, job_title = $title, leader_email = $leader,
         leader_open_id = NULL, active = 1, source = 'roster', updated_at = $now
       WHERE id = $id`,
    );
    const insert = db.query(
      `INSERT INTO users (email, name, en_name, dept_id, job_title, leader_email, active, source, created_at, updated_at)
       VALUES ($email, $name, $en, $dept, $title, $leader, 1, 'roster', $now, $now)`,
    );
    const clearAvatar = db.query("UPDATE users SET avatar_src = NULL, avatar_ver = NULL WHERE id = $id");
    for (const e of entries) {
      const fields = {
        name: e.name,
        en: e.enName,
        dept: e.department ? deptId(e.department) : null,
        title: e.title,
        leader: e.manager,
        now,
      };
      let row = byEmail.get({ email: e.email }) as Existing | null;
      if (row) update.run({ ...fields, id: row.id });
      else row = { id: Number(insert.run({ ...fields, email: e.email }).lastInsertRowid), avatar_src: null, avatar_ver: null };
      if (e.avatar) jobs.push({ row, entry: e });
      else if (row.avatar_ver) clearAvatar.run({ id: row.id });
    }
    db.query(
      `UPDATE users SET active = 0, updated_at = $now
       WHERE source = 'roster' AND active = 1 AND email NOT IN (SELECT value FROM json_each($emails))`,
    ).run({ now, emails: JSON.stringify(entries.map((e) => e.email)) });
  })();

  let avatarsUpdated = 0;
  const setAvatar = db.query("UPDATE users SET avatar_src = $src, avatar_ver = $ver WHERE id = $id");
  for (const { row, entry } of jobs) {
    const avatar = entry.avatar!;
    const src = avatar.kind === "file" ? avatar.path : avatar.url;
    try {
      let bytes: Uint8Array;
      if (avatar.kind === "url") {
        // Remote images are re-fetched only when the URL changes.
        if (src === row.avatar_src && row.avatar_ver && existsSync(avatarFile(row.id, "240"))) continue;
        const res = await fetch(avatar.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        bytes = await Bun.file(avatar.path).bytes();
      }
      if (sniff(bytes) === "application/octet-stream") throw new Error("not a JPEG, PNG, WebP or GIF image");
      const ver = Bun.hash(bytes).toString(36).slice(0, 10);
      if (ver === row.avatar_ver && existsSync(avatarFile(row.id, "240"))) continue;
      await writeAvatar(row.id, "240", bytes);
      await writeAvatar(row.id, "640", bytes);
      setAvatar.run({ src, ver, id: row.id });
      avatarsUpdated++;
    } catch (e) {
      warnings.push(`avatar for ${entry.email} (${src}): ${(e as Error).message}`);
    }
  }
  return { seen: entries.length, active: entries.length, avatarsUpdated, warnings };
}
