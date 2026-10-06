import { env } from "cloudflare:workers";
import { putAvatar, shortHash } from "./avatars";
import { db, q } from "./db";
import type { SyncResult } from "./directory";
import { parseRoster } from "./roster-file";

// scripts/push-roster.ts (run by scripts/deploy.sh) uploads ROSTER_FILE to R2 as
// roster/roster.csv (or .json), the avatar files under roster/ with their relative paths,
// and roster/_version, which changes whenever any of them does.
const ROSTER_KEYS = ["roster/roster.csv", "roster/roster.json"];

// The uploaded roster and the version to compare against the last sync.
export async function rosterObject() {
  for (const key of ROSTER_KEYS) {
    const head = await env.FILES.head(key);
    if (!head) continue;
    const version = await env.FILES.head("roster/_version");
    return { key, etag: version?.etag ?? head.etag };
  }
  return null;
}

type Existing = { id: number; email: string; avatar_src: string | null; avatar_ver: string | null; avatar_key: string | null };

// Mirrors the uploaded roster into users/departments. People who drop out of it are
// deactivated (their history stays); a roster with any error changes nothing.
export async function syncRoster(): Promise<SyncResult> {
  const found = await rosterObject();
  const obj = found && (await env.FILES.get(found.key));
  if (!found || !obj) throw new Error("no roster uploaded yet; scripts/deploy.sh uploads ROSTER_FILE");
  const { entries, errors, warnings } = parseRoster(await obj.text(), found.key.endsWith(".json"));
  if (errors.length) throw new Error(errors.join("; "));

  const uploaded = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: "roster/", cursor });
    for (const o of page.objects) uploaded.set(o.key, o.etag);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const emails = JSON.stringify(entries.map((e) => e.email));
  const existing = await db.all<Existing>(
    "SELECT id, email, avatar_src, avatar_ver, avatar_key FROM users WHERE email IN (SELECT value FROM json_each($emails))",
    { emails },
  );
  const before = new Map(existing.map((r) => [r.email, r]));

  let avatarsUpdated = 0;
  const remote: { email: string; url: string }[] = [];
  const people = entries.map((e) => {
    const prev = before.get(e.email);
    let avatar: { src: string; ver: string | null; key: string | null } | null = null;
    if (e.avatar?.kind === "file") {
      const key = `roster/${e.avatar.path}`;
      const etag = uploaded.get(key);
      if (etag) avatar = { src: e.avatar.path, ver: etag.slice(0, 12), key };
      else warnings.push(`line ${e.line}: avatar for ${e.email} was not uploaded: ${e.avatar.path}`);
    } else if (e.avatar?.kind === "url") {
      // Remote images are downloaded only when the URL changes.
      if (prev?.avatar_src === e.avatar.url && prev.avatar_ver) avatar = { src: e.avatar.url, ver: prev.avatar_ver, key: prev.avatar_key };
      else (avatar = { src: e.avatar.url, ver: null, key: null }), remote.push({ email: e.email, url: e.avatar.url });
    }
    if (avatar?.ver && avatar.ver !== prev?.avatar_ver) avatarsUpdated++;
    return {
      email: e.email,
      name: e.name,
      en: e.enName,
      dept: e.department ? `roster:${e.department}` : null,
      title: e.title,
      manager: e.manager,
      avatarSrc: avatar?.src ?? null,
      avatarVer: avatar?.ver ?? null,
      avatarKey: avatar?.key ?? null,
    };
  });
  const departments = new Map<string, string | null>();
  for (const e of entries) if (e.department && !departments.get(e.department)) departments.set(e.department, e.departmentEn);

  const now = Date.now();
  const field = (name: string) => `json_extract(value, '$.${name}')`;
  await db.batch([
    q(
      `INSERT INTO departments (id, name, en_name, parent_id, updated_at)
       SELECT 'roster:' || ${field("name")}, ${field("name")}, ${field("en")}, NULL, $now FROM json_each($depts) WHERE true
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, en_name = excluded.en_name, updated_at = excluded.updated_at`,
      { now, depts: JSON.stringify([...departments].map(([name, en]) => ({ name, en }))) },
    ),
    q(
      `INSERT INTO users (email, name, en_name, dept_id, job_title, leader_email, avatar_src, avatar_ver, avatar_key,
                          active, source, created_at, updated_at)
       SELECT ${field("email")}, ${field("name")}, ${field("en")}, ${field("dept")}, ${field("title")}, ${field("manager")},
              ${field("avatarSrc")}, ${field("avatarVer")}, ${field("avatarKey")}, 1, 'roster', $now, $now
       FROM json_each($people) WHERE true
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, en_name = excluded.en_name, dept_id = excluded.dept_id,
         job_title = excluded.job_title, leader_email = excluded.leader_email, leader_open_id = NULL,
         avatar_src = excluded.avatar_src, avatar_ver = excluded.avatar_ver, avatar_key = excluded.avatar_key,
         active = 1, source = 'roster', updated_at = excluded.updated_at`,
      { now, people: JSON.stringify(people) },
    ),
    q(
      `UPDATE users SET active = 0, updated_at = $now
       WHERE source = 'roster' AND active = 1 AND email NOT IN (SELECT value FROM json_each($emails))`,
      { now, emails },
    ),
  ]);

  if (remote.length) {
    const ids = await db.all<{ id: number; email: string }>(
      "SELECT id, email FROM users WHERE email IN (SELECT value FROM json_each($emails))",
      { emails: JSON.stringify(remote.map((r) => r.email)) },
    );
    const idOf = new Map(ids.map((r) => [r.email, r.id]));
    const done: { id: number; ver: string; key: string }[] = [];
    for (const { email, url } of remote) {
      const id = idOf.get(email)!;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const key = `avatars/${id}-240`;
        await putAvatar(key, new Uint8Array(await res.arrayBuffer()));
        done.push({ id, ver: await shortHash(url), key });
      } catch (e) {
        warnings.push(`avatar for ${email} (${url}): ${(e as Error).message}`);
      }
    }
    if (done.length) {
      await db.run(
        `UPDATE users SET avatar_ver = j.ver, avatar_key = j.key
         FROM (SELECT ${field("id")} AS id, ${field("ver")} AS ver, ${field("key")} AS key FROM json_each($done)) AS j
         WHERE users.id = j.id`,
        { done: JSON.stringify(done) },
      );
      avatarsUpdated += done.length;
    }
  }
  return { seen: entries.length, active: entries.length, avatarsUpdated, warnings };
}
