import { mkdirSync, existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { config, isAllowedEmail, larkEnabled } from "./config";
import { db } from "./db";
import { valueById } from "../shared/values";

const log = (...args: unknown[]) => console.log("[lark]", ...args);

export const avatarDir = join(config.dataDir, "avatars");
mkdirSync(avatarDir, { recursive: true });

// ---------------------------------------------------------------- client

type LarkBody<T> = { code: number; msg: string; data?: T; tenant_access_token?: string; expire?: number };

let token: { value: string; expiresAt: number } | null = null;

async function tenantToken(force = false) {
  if (!force && token && Date.now() < token.expiresAt) return token.value;
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
        await Bun.sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`${method} ${path} → ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}` }))) as LarkBody<T>;
    refresh = res.status === 401 || json.code === 99991661 || json.code === 99991663;
    const limited = res.status === 429 || json.code === 99991400;
    if ((limited || refresh || res.status >= 500) && attempt < 5) {
      await Bun.sleep(Math.min(8000, 500 * 2 ** attempt));
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
};

const ID_TYPES = { user_id_type: "open_id", department_id_type: "open_department_id" };

async function fetchDirectory() {
  const deptIds = new Set<string>();
  const looseUsers = new Set<string>();
  for await (const page of paginate<never>("/open-apis/contact/v3/scopes", { ...ID_TYPES, page_size: "100" }, "department_ids")) {
    for (const id of page as string[]) deptIds.add(id);
  }
  for await (const page of paginate<never>("/open-apis/contact/v3/scopes", { ...ID_TYPES, page_size: "100" }, "user_ids")) {
    for (const id of page as string[]) looseUsers.add(id);
  }

  const departments = new Map<string, LarkDept>();
  for (const id of [...deptIds]) {
    if (id !== "0") {
      try {
        const d = await lark<{ department: LarkDept }>("GET", `/open-apis/contact/v3/departments/${id}`, ID_TYPES);
        if (d?.department) departments.set(id, d.department);
      } catch (e) {
        log("department lookup failed", id, (e as Error).message);
      }
    }
    for await (const page of paginate<LarkDept>(`/open-apis/contact/v3/departments/${id}/children`, {
      ...ID_TYPES,
      fetch_child: "true",
      page_size: "50",
    })) {
      for (const d of page) if (!d.status?.is_deleted) departments.set(d.open_department_id, d);
    }
  }

  const users = new Map<string, LarkUser>();
  const memberDepts = new Set([...deptIds, ...departments.keys()]);
  for (const id of memberDepts) {
    for await (const page of paginate<LarkUser>("/open-apis/contact/v3/users/find_by_department", {
      ...ID_TYPES,
      department_id: id,
      page_size: "50",
    })) {
      for (const u of page) users.set(u.open_id, u);
    }
  }
  const missing = [...looseUsers].filter((id) => !users.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const data = await lark<{ items?: LarkUser[] }>("GET", "/open-apis/contact/v3/users/batch", {
      user_id_type: "open_id",
      user_ids: missing.slice(i, i + 50),
    });
    for (const u of data?.items ?? []) users.set(u.open_id, u);
  }
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
  const sizes: [string, string | undefined][] = [
    ["240", u.avatar?.avatar_240],
    ["640", u.avatar?.avatar_640 ?? u.avatar?.avatar_origin],
  ];
  for (const [size, url] of sizes) {
    if (!url) continue;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`avatar HTTP ${res.status}`);
    const file = join(avatarDir, `${userId}-${size}`);
    await Bun.write(`${file}.tmp`, await res.arrayBuffer());
    await rename(`${file}.tmp`, file);
  }
}

let running: Promise<unknown> | null = null;

export function syncDirectory(trigger: string) {
  if (!larkEnabled()) return Promise.reject(new Error("LARK_APP_ID / LARK_APP_SECRET not configured"));
  running ??= runSync(trigger).finally(() => (running = null));
  return running;
}

export const syncRunning = () => running !== null;

async function runSync(trigger: string) {
  const started = Date.now();
  const run = db.query("INSERT INTO sync_runs (trigger, started_at) VALUES ($trigger, $now)").run({ trigger, now: started });
  const runId = Number(run.lastInsertRowid);
  try {
    const { departments, users } = await fetchDirectory();
    // Lark silently omits fields the app has no scope for; don't store nameless people.
    const list = [...users.values()];
    if (list.length && list.every((u) => !u.name)) throw new Error("users have no name: grant contact:user.base:readonly");
    if (list.length && list.every((u) => !u.email && !u.enterprise_email)) {
      throw new Error("users have no email: grant contact:user.email:readonly");
    }
    const now = Date.now();

    db.transaction(() => {
      const up = db.query(
        `INSERT INTO departments (id, name, en_name, parent_id, updated_at) VALUES ($id, $name, $en, $parent, $now)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, en_name = excluded.en_name,
           parent_id = excluded.parent_id, updated_at = excluded.updated_at`,
      );
      for (const [id, d] of departments) {
        up.run({ id, name: d.name, en: d.i18n_name?.en_us || null, parent: d.parent_department_id ?? null, now });
      }
    })();

    const avatarJobs: { id: number; user: LarkUser; ver: string }[] = [];
    const byOpenId = db.query("SELECT id, email, avatar_src, avatar_ver FROM users WHERE open_id = $openId");
    const byEmail = db.query("SELECT id, email, avatar_src, avatar_ver FROM users WHERE email = $email AND open_id IS NULL");
    const emailTaken = db.query("SELECT id FROM users WHERE email = $email AND id != $id");
    type Existing = { id: number; email: string | null; avatar_src: string | null; avatar_ver: string | null };

    db.transaction(() => {
      for (const u of users.values()) {
        const email = pickEmail(u);
        const active = u.status?.is_resigned || u.status?.is_exited || u.status?.is_frozen ? 0 : 1;
        const fields = {
          openId: u.open_id,
          name: u.name || u.en_name || email?.split("@")[0] || "?",
          en: u.en_name || null,
          dept: primaryDept(u),
          title: u.job_title || null,
          active,
          joined: u.join_time ? u.join_time * 1000 : null,
          now,
        };
        let row = (byOpenId.get({ openId: u.open_id }) ?? (email ? byEmail.get({ email }) : null)) as Existing | null;
        const safeEmail = email && !(emailTaken.get({ email, id: row?.id ?? -1 }) as unknown) ? email : (row?.email ?? null);
        if (row) {
          db.query(
            `UPDATE users SET open_id = $openId, email = $email, name = $name, en_name = $en, dept_id = $dept,
               job_title = $title, active = $active, joined_at = $joined, source = 'lark', updated_at = $now
             WHERE id = $id`,
          ).run({ ...fields, email: safeEmail, id: row.id });
        } else {
          const res = db
            .query(
              `INSERT INTO users (open_id, email, name, en_name, dept_id, job_title, active, joined_at, source, created_at, updated_at)
               VALUES ($openId, $email, $name, $en, $dept, $title, $active, $joined, 'lark', $now, $now)`,
            )
            .run({ ...fields, email: safeEmail });
          row = { id: Number(res.lastInsertRowid), email: safeEmail, avatar_src: null, avatar_ver: null };
        }
        const src = u.avatar?.avatar_240 ?? null;
        if (!src) {
          if (row.avatar_ver) db.query("UPDATE users SET avatar_src = NULL, avatar_ver = NULL WHERE id = $id").run({ id: row.id });
        } else if (src !== row.avatar_src || !existsSync(join(avatarDir, `${row.id}-240`))) {
          avatarJobs.push({ id: row.id, user: u, ver: Bun.hash(src).toString(36).slice(0, 10) });
        }
      }
      // People who left (or fell out of the app's contact scope) stay in history but
      // disappear from pickers. Guard against a broken sync deactivating everyone.
      if (users.size > 0) {
        db.query(
          `UPDATE users SET active = 0, updated_at = $now
           WHERE source = 'lark' AND active = 1 AND open_id NOT IN (SELECT value FROM json_each($seen))`,
        ).run({ now, seen: JSON.stringify([...users.keys()]) });
      }
    })();

    let avatarsUpdated = 0;
    const setAvatar = db.query("UPDATE users SET avatar_src = $src, avatar_ver = $ver WHERE id = $id");
    const queue = [...avatarJobs];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          try {
            await downloadAvatar(job.id, job.user);
            setAvatar.run({ src: job.user.avatar!.avatar_240!, ver: job.ver, id: job.id });
            avatarsUpdated++;
          } catch (e) {
            log("avatar failed", job.user.open_id, (e as Error).message);
          }
        }
      }),
    );

    const activeCount = [...users.values()].filter((u) => !(u.status?.is_resigned || u.status?.is_exited || u.status?.is_frozen)).length;
    db.query(
      `UPDATE sync_runs SET finished_at = $now, ok = 1, users_seen = $seen, users_active = $active, avatars_updated = $avatars
       WHERE id = $id`,
    ).run({ now: Date.now(), seen: users.size, active: activeCount, avatars: avatarsUpdated, id: runId });
    log(`sync ok: ${users.size} users (${activeCount} active), ${departments.size} depts, ${avatarsUpdated} avatars updated`);
    return { users: users.size, active: activeCount, avatarsUpdated };
  } catch (e) {
    const message = (e as Error).message;
    db.query("UPDATE sync_runs SET finished_at = $now, ok = 0, error = $error WHERE id = $id").run({
      now: Date.now(),
      error: message,
      id: runId,
    });
    log("sync failed:", message);
    throw e;
  }
}

export function lastSuccessfulSync() {
  const row = db.query("SELECT finished_at FROM sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1").get() as
    | { finished_at: number }
    | null;
  return row?.finished_at ?? 0;
}

// ---------------------------------------------------------------- notifications

type NotifyPost = { id: number; kind: "kudos" | "bonus"; message: string; valueTag: string | null; points: number };

const copy = {
  zh: {
    kudos: (s: string) => `${s} 夸了你`,
    bonus: (s: string, p: number) => `${s} 给你发了一份 Peer Bonus · +${p}`,
    open: "去看看",
    broadcastKudos: (s: string, r: string) => `${s} 夸了 ${r}`,
    broadcastBonus: (s: string, r: string, p: number) => `${s} 给 ${r} 发了 Peer Bonus · 每人 +${p}`,
    sentKudos: (r: string) => `你夸了 ${r}`,
    sentBonus: (r: string, p: number, many: boolean) => `你给 ${r} 发了 Peer Bonus · ${many ? "每人 " : ""}+${p}`,
    remaining: (n: number) => `本月剩余 ${n} 积分`,
    andMore: (n: number) => `等 ${n} 人`,
    sep: "、",
  },
  en: {
    kudos: (s: string) => `${s} sent you kudos`,
    bonus: (s: string, p: number) => `${s} sent you a Peer Bonus · +${p}`,
    open: "Open",
    broadcastKudos: (s: string, r: string) => `${s} gave kudos to ${r}`,
    broadcastBonus: (s: string, r: string, p: number) => `${s} sent ${r} a Peer Bonus · +${p} each`,
    sentKudos: (r: string) => `You gave kudos to ${r}`,
    sentBonus: (r: string, p: number, many: boolean) => `You sent ${r} a Peer Bonus · +${p}${many ? " each" : ""}`,
    remaining: (n: number) => `${n} pts left this month`,
    andMore: (n: number) => ` and ${n} others`,
    sep: ", ",
  },
};

function card(title: string, post: NotifyPost, lang: "zh" | "en", footer: string) {
  const tag = valueById(post.valueTag);
  const note = [tag ? `# ${lang === "zh" ? tag.zh : tag.en}` : null, footer].filter(Boolean).join("  ·  ");
  return {
    config: { wide_screen_mode: true },
    header: { template: post.kind === "bonus" ? "orange" : "carmine", title: { tag: "plain_text", content: title } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: `“${post.message}”` } },
      ...(note ? [{ tag: "note", elements: [{ tag: "plain_text", content: note }] }] : []),
      {
        tag: "action",
        actions: [
          { tag: "button", type: "primary", text: { tag: "plain_text", content: copy[lang].open }, url: `${config.publicUrl}/k/${post.id}` },
        ],
      },
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

// Recipients get "X thanked you"; the sender gets a receipt "you thanked X, Y";
// optionally the whole thing is broadcast to a group chat.
export async function notifyPost(post: NotifyPost, senderId: number, recipientIds: number[], senderRemaining?: number) {
  if (!larkEnabled() || !config.lark.notify) return;
  const people = db
    .query("SELECT id, name, en_name, open_id, lang FROM users WHERE id IN (SELECT value FROM json_each($ids))")
    .all({ ids: JSON.stringify([senderId, ...recipientIds]) }) as {
    id: number;
    name: string;
    en_name: string | null;
    open_id: string | null;
    lang: string | null;
  }[];
  const byId = new Map(people.map((p) => [p.id, p]));
  const sender = byId.get(senderId);
  if (!sender) return;
  const nameIn = (p: { name: string; en_name: string | null }, lang: "zh" | "en") => (lang === "en" && p.en_name) || p.name;
  const names = (lang: "zh" | "en") => {
    const c = copy[lang];
    const all = recipientIds.map((id) => byId.get(id)).map((p) => (p ? nameIn(p, lang) : "?"));
    return all.length <= 3 ? all.join(c.sep) : all.slice(0, 3).join(c.sep) + c.andMore(all.length);
  };
  const site = `夸夸 · ${new URL(config.publicUrl).host}`;

  const jobs = recipientIds.map(async (rid) => {
    const r = byId.get(rid);
    if (!r?.open_id) return;
    const lang = r.lang === "en" ? "en" : "zh";
    const c = copy[lang];
    const title = post.kind === "bonus" ? c.bonus(nameIn(sender, lang), post.points) : c.kudos(nameIn(sender, lang));
    await send("open_id", r.open_id, card(title, post, lang, site));
  });
  if (sender.open_id) {
    const lang = sender.lang === "en" ? "en" : "zh";
    const c = copy[lang];
    const many = recipientIds.length > 1;
    const title = post.kind === "bonus" ? c.sentBonus(names(lang), post.points, many) : c.sentKudos(names(lang));
    const footer = post.kind === "bonus" && senderRemaining !== undefined ? c.remaining(senderRemaining) : site;
    jobs.push(send("open_id", sender.open_id, card(title, post, lang, footer)));
  }
  if (config.lark.broadcastChatId) {
    jobs.push(
      (async () => {
        const c = copy.zh;
        const title =
          post.kind === "bonus" ? c.broadcastBonus(sender.name, names("zh"), post.points) : c.broadcastKudos(sender.name, names("zh"));
        await send("chat_id", config.lark.broadcastChatId, card(title, post, "zh", ""));
      })(),
    );
  }
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "rejected") log("notify failed:", (r.reason as Error).message);
  }
}
