import { putAvatar, shortHash } from "./avatars";
import { config, isAllowedEmail } from "./config";
import { db, q } from "./db";
import type { SyncResult } from "./directory";
import { copy, site, type Notice } from "./notify";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (...args: unknown[]) => console.log("[lark]", ...args);

// ---------------------------------------------------------------- client

type LarkBody<T> = { code: number; msg: string; data?: T; tenant_access_token?: string; expire?: number };

// Cached per Worker instance; concurrent callers share one in-flight request.
let token: { value: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string> | null = null;

function tenantToken(force = false): Promise<string> {
  if (!force && token && Date.now() < token.expiresAt) return Promise.resolve(token.value);
  tokenRequest ??= fetchTenantToken().finally(() => (tokenRequest = null));
  return tokenRequest;
}

async function fetchTenantToken() {
  const res = await fetch(`${config.lark.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: config.lark.appId, app_secret: config.lark.appSecret }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as LarkBody<never>;
  if (body.code !== 0 || !body.tenant_access_token) throw new Error(`tenant_access_token failed: ${body.code} ${body.msg}`);
  token = { value: body.tenant_access_token, expiresAt: Date.now() + ((body.expire ?? 7200) - 300) * 1000 };
  return token.value;
}

async function lark<T>(method: string, path: string, query?: Record<string, string | string[] | undefined>, body?: unknown) {
  const url = new URL(config.lark.baseUrl + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  let refresh = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await tenantToken(refresh)}`, "Content-Type": "application/json; charset=utf-8" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // Timeouts and connection resets: retry like a 5xx.
      if (attempt < 5) {
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`${method} ${path} → ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}` }))) as LarkBody<T>;
    refresh = res.status === 401 || json.code === 99991661 || json.code === 99991663;
    const limited = res.status === 429 || json.code === 99991400;
    if ((limited || refresh || res.status >= 500) && attempt < 5) {
      await sleep(Math.min(8000, 500 * 2 ** attempt));
      continue;
    }
    if (json.code !== 0) throw new Error(`${method} ${path} → ${json.code} ${json.msg}`);
    return json.data as T;
  }
}

async function* paginate<T>(path: string, query: Record<string, string | undefined>, key = "items") {
  let pageToken: string | undefined;
  do {
    const data = await lark<Record<string, unknown>>("GET", path, { ...query, page_token: pageToken });
    yield ((data?.[key] as T[]) ?? []) as T[];
    pageToken = data?.has_more ? (data.page_token as string) : undefined;
  } while (pageToken);
}

// ---------------------------------------------------------------- sync

type LarkDept = {
  open_department_id: string;
  name: string;
  i18n_name?: { en_us?: string };
  parent_department_id?: string;
  status?: { is_deleted?: boolean };
};

type LarkUser = {
  open_id: string;
  name: string;
  en_name?: string;
  email?: string;
  enterprise_email?: string;
  avatar?: { avatar_240?: string; avatar_640?: string; avatar_origin?: string };
  status?: { is_frozen?: boolean; is_resigned?: boolean; is_exited?: boolean };
  department_ids?: string[];
  orders?: { department_id: string; is_primary_dept?: boolean }[];
  job_title?: string;
  join_time?: number;
  leader_user_id?: string;
};

const ID_TYPES = { user_id_type: "open_id", department_id_type: "open_department_id" };

// Runs fn over items with at most `limit` in flight.
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

async function collect<T>(path: string, query: Record<string, string | undefined>, key = "items") {
  const out: T[] = [];
  for await (const page of paginate<T>(path, query, key)) out.push(...page);
  return out;
}

// Departments and their members are fetched in parallel (pages of one department in order):
// done one at a time, ~25 departments took ~30 s, too close to Workers' limits.
const LARK_CONCURRENCY = 6;

async function fetchDirectory() {
  const scopes = { ...ID_TYPES, page_size: "100" };
  const [deptIds, looseUsers] = await Promise.all([
    collect<string>("/open-apis/contact/v3/scopes", scopes, "department_ids"),
    collect<string>("/open-apis/contact/v3/scopes", scopes, "user_ids"),
  ]);

  const departments = new Map<string, LarkDept>();
  await pool([...new Set(deptIds)], LARK_CONCURRENCY, async (id) => {
    if (id !== "0") {
      try {
        const d = await lark<{ department: LarkDept }>("GET", `/open-apis/contact/v3/departments/${id}`, ID_TYPES);
        if (d?.department) departments.set(id, d.department);
      } catch (e) {
        log("department lookup failed", id, (e as Error).message);
      }
    }
    const children = await collect<LarkDept>(`/open-apis/contact/v3/departments/${id}/children`, {
      ...ID_TYPES,
      fetch_child: "true",
      page_size: "50",
    });
    for (const d of children) if (!d.status?.is_deleted) departments.set(d.open_department_id, d);
  });

  const users = new Map<string, LarkUser>();
  await pool([...new Set([...deptIds, ...departments.keys()])], LARK_CONCURRENCY, async (id) => {
    const members = await collect<LarkUser>("/open-apis/contact/v3/users/find_by_department", {
      ...ID_TYPES,
      department_id: id,
      page_size: "50",
    });
    for (const u of members) users.set(u.open_id, u);
  });

  const missing = [...new Set(looseUsers)].filter((id) => !users.has(id));
  const batches = Array.from({ length: Math.ceil(missing.length / 50) }, (_, i) => missing.slice(i * 50, i * 50 + 50));
  await pool(batches, LARK_CONCURRENCY, async (ids) => {
    const data = await lark<{ items?: LarkUser[] }>("GET", "/open-apis/contact/v3/users/batch", { user_id_type: "open_id", user_ids: ids });
    for (const u of data?.items ?? []) users.set(u.open_id, u);
  });
  return { departments, users };
}

function pickEmail(u: LarkUser) {
  const candidates = [u.enterprise_email, u.email].filter(Boolean).map((e) => e!.trim().toLowerCase());
  return candidates.find(isAllowedEmail) ?? candidates[0] ?? null;
}

function primaryDept(u: LarkUser) {
  return u.orders?.find((o) => o.is_primary_dept)?.department_id ?? u.department_ids?.[0] ?? null;
}

async function downloadAvatar(userId: number, u: LarkUser) {
  const sizes: ["240" | "640", string | undefined][] = [
    ["240", u.avatar?.avatar_240],
    ["640", u.avatar?.avatar_640 ?? u.avatar?.avatar_origin],
  ];
  for (const [size, url] of sizes) {
    if (!url) continue;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`avatar HTTP ${res.status}`);
    await putAvatar(`avatars/${userId}-${size}`, new Uint8Array(await res.arrayBuffer()));
  }
}

type Existing = { id: number; open_id: string | null; email: string | null; avatar_src: string | null; avatar_ver: string | null };

// Pulls the whole Lark contact directory into users/departments (directory.syncDirectory()
// runs it daily). Writes are a handful of set-based statements in one atomic batch, and
// avatars are only downloaded when Lark's avatar URL changed since the last sync.
export async function syncLark(): Promise<SyncResult> {
  const { departments, users } = await fetchDirectory();
  // Lark silently omits fields the app has no scope for; don't store nameless people.
  const list = [...users.values()];
  if (list.length && list.every((u) => !u.name)) throw new Error("users have no name: grant contact:user.base:readonly");
  if (list.length && list.every((u) => !u.email && !u.enterprise_email)) {
    throw new Error("users have no email: grant contact:user.email:readonly");
  }
  const now = Date.now();

  // Match each Lark user to an existing row by open_id, else adopt a row that signed in
  // by email before the sync knew them. An email already taken by another row is skipped.
  const existing = await db.all<Existing>("SELECT id, open_id, email, avatar_src, avatar_ver FROM users");
  const byOpenId = new Map(existing.filter((r) => r.open_id).map((r) => [r.open_id!, r]));
  const adoptable = new Map(existing.filter((r) => r.email && !r.open_id).map((r) => [r.email!, r]));
  const emailOwner = new Map(existing.filter((r) => r.email).map((r) => [r.email!, r.id]));
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  for (const u of list) {
    const email = pickEmail(u);
    let row = byOpenId.get(u.open_id);
    if (!row && email && adoptable.has(email)) (row = adoptable.get(email)), adoptable.delete(email);
    const owner = email ? emailOwner.get(email) : undefined;
    const safeEmail = email && (owner === undefined || owner === row?.id) ? email : (row?.email ?? null);
    if (safeEmail) emailOwner.set(safeEmail, row?.id ?? -1);
    const fields = {
      open_id: u.open_id,
      email: safeEmail,
      name: u.name || u.en_name || email?.split("@")[0] || "?",
      en_name: u.en_name || null,
      dept_id: primaryDept(u),
      job_title: u.job_title || null,
      active: u.status?.is_resigned || u.status?.is_exited || u.status?.is_frozen ? 0 : 1,
      joined_at: u.join_time ? u.join_time * 1000 : null,
      leader_open_id: u.leader_user_id || null,
    };
    if (row) updates.push({ id: row.id, ...fields });
    else inserts.push(fields);
  }

  const field = (name: string) => `json_extract(value, '$.${name}')`;
  const columns = ["open_id", "email", "name", "en_name", "dept_id", "job_title", "active", "joined_at", "leader_open_id"];
  await db.batch([
    q(
      `INSERT INTO departments (id, name, en_name, parent_id, updated_at)
       SELECT ${field("id")}, ${field("name")}, ${field("en")}, ${field("parent")}, $now FROM json_each($depts) WHERE true
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, en_name = excluded.en_name,
         parent_id = excluded.parent_id, updated_at = excluded.updated_at`,
      {
        now,
        depts: JSON.stringify(
          [...departments].map(([id, d]) => ({ id, name: d.name, en: d.i18n_name?.en_us || null, parent: d.parent_department_id ?? null })),
        ),
      },
    ),
    q(
      `UPDATE users SET ${columns.map((c) => `${c} = j.${c}`).join(", ")}, leader_email = NULL, source = 'lark', updated_at = $now
       FROM (SELECT ${field("id")} AS id, ${columns.map((c) => `${field(c)} AS ${c}`).join(", ")} FROM json_each($rows)) AS j
       WHERE users.id = j.id`,
      { now, rows: JSON.stringify(updates) },
    ),
    q(
      `INSERT INTO users (${columns.join(", ")}, source, created_at, updated_at)
       SELECT ${columns.map(field).join(", ")}, 'lark', $now, $now FROM json_each($rows)`,
      { now, rows: JSON.stringify(inserts) },
    ),
    // People who left (or fell out of the app's contact scope) stay in history but
    // disappear from pickers. Guard against a broken sync deactivating everyone.
    q(
      `UPDATE users SET active = 0, updated_at = $now
       WHERE source = 'lark' AND active = 1 AND $count > 0 AND open_id NOT IN (SELECT value FROM json_each($seen))`,
      { now, count: users.size, seen: JSON.stringify([...users.keys()]) },
    ),
  ]);

  const rows = await db.all<Existing>(
    "SELECT id, open_id, email, avatar_src, avatar_ver FROM users WHERE open_id IN (SELECT value FROM json_each($seen))",
    { seen: JSON.stringify([...users.keys()]) },
  );
  const jobs: { id: number; user: LarkUser; src: string }[] = [];
  const cleared: number[] = [];
  for (const row of rows) {
    const src = users.get(row.open_id!)?.avatar?.avatar_240;
    if (!src) row.avatar_ver && cleared.push(row.id);
    else if (src !== row.avatar_src || !row.avatar_ver) jobs.push({ id: row.id, user: users.get(row.open_id!)!, src });
  }
  const done: { id: number; src: string; ver: string; key: string }[] = [];
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          await downloadAvatar(job.id, job.user);
          done.push({ id: job.id, src: job.src, ver: await shortHash(job.src), key: `avatars/${job.id}-240` });
        } catch (e) {
          log("avatar failed", job.user.open_id, (e as Error).message);
        }
      }
    }),
  );
  await db.batch([
    q(
      `UPDATE users SET avatar_src = j.src, avatar_ver = j.ver, avatar_key = j.key
       FROM (SELECT ${field("id")} AS id, ${field("src")} AS src, ${field("ver")} AS ver, ${field("key")} AS key FROM json_each($done)) AS j
       WHERE users.id = j.id`,
      { done: JSON.stringify(done) },
    ),
    q("UPDATE users SET avatar_src = NULL, avatar_ver = NULL, avatar_key = NULL WHERE id IN (SELECT value FROM json_each($ids))", {
      ids: JSON.stringify(cleared),
    }),
  ]);

  const activeCount = list.filter((u) => !(u.status?.is_resigned || u.status?.is_exited || u.status?.is_frozen)).length;
  return { seen: users.size, active: activeCount, avatarsUpdated: done.length, warnings: [] };
}

// ---------------------------------------------------------------- notifications

function card(n: Notice) {
  const c = copy[n.lang];
  // DMs end with the site (or, on the sender's Peer Bonus receipt, the allowance left); the
  // group broadcast doesn't.
  const tail = n.role === "broadcast" ? null : (n.remaining ?? site());
  const note = [...n.details, tail].filter(Boolean).join("  ·  ");
  return {
    config: { wide_screen_mode: true },
    header: {
      template: n.role === "cc" ? "wathet" : n.post.kind === "bonus" ? "orange" : "carmine",
      title: { tag: "plain_text", content: n.title },
    },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: `“${n.post.message}”` } },
      ...(note ? [{ tag: "note", elements: [{ tag: "plain_text", content: note }] }] : []),
      { tag: "action", actions: [{ tag: "button", type: "primary", text: { tag: "plain_text", content: c.open }, url: n.url }] },
    ],
  };
}

async function send(receiveIdType: "open_id" | "chat_id", receiveId: string, content: unknown) {
  await lark("POST", "/open-apis/im/v1/messages", { receive_id_type: receiveIdType }, {
    receive_id: receiveId,
    msg_type: "interactive",
    content: JSON.stringify(content),
  });
}

// One card per notice: DMs by open_id, the broadcast to LARK_BROADCAST_CHAT_ID if set.
export async function sendLarkNotices(notices: Notice[]) {
  const jobs = notices.flatMap((n) => {
    if (n.role === "broadcast") return config.lark.broadcastChatId ? [send("chat_id", config.lark.broadcastChatId, card(n))] : [];
    return n.person?.open_id ? [send("open_id", n.person.open_id, card(n))] : [];
  });
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "rejected") log("notify failed:", (r.reason as Error).message);
  }
}
