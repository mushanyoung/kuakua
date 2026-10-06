import { ADMIN_EMAILS, config, isAllowedEmail } from "./config";
import { db } from "./db";
import { periodBounds, periodOf, rangeStart, type Range } from "./time";
import { LIMITS, REACTIONS, isValueId } from "../shared/values";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

type UserRow = {
  id: number;
  open_id: string | null;
  email: string | null;
  name: string;
  en_name: string | null;
  avatar_ver: string | null;
  dept_id: string | null;
  dept_name: string | null;
  dept_en: string | null;
  job_title: string | null;
  active: number;
  source: string;
  lang: string | null;
  joined_at: number | null;
  last_seen_at: number | null;
  leader_id: number | null;
};

export type UserDTO = {
  id: number;
  name: string;
  enName: string | null;
  avatar: string;
  dept: string | null;
  deptEn: string | null;
  title: string | null;
  active: boolean;
  joinedAt: number | null;
  handle: string | null;
  leaderId: number | null;
};

const USER_SELECT = `
  SELECT u.id, u.open_id, u.email, u.name, u.en_name, u.avatar_ver, u.dept_id, u.job_title,
         u.active, u.source, u.lang, u.joined_at, u.last_seen_at,
         d.name AS dept_name, d.en_name AS dept_en, l.id AS leader_id
  FROM users u LEFT JOIN departments d ON d.id = u.dept_id
  LEFT JOIN users l ON l.active = 1 AND (l.open_id = u.leader_open_id OR l.email = u.leader_email)`;

export function toUser(r: UserRow): UserDTO {
  return {
    id: r.id,
    name: r.name,
    enName: r.en_name || null,
    avatar: `/avatars/${r.id}${r.avatar_ver ? `?v=${r.avatar_ver}` : ""}`,
    dept: r.dept_name,
    deptEn: r.dept_en || null,
    title: r.job_title || null,
    active: r.active === 1,
    joinedAt: r.joined_at,
    handle: r.email ? r.email.split("@")[0]! : null,
    leaderId: r.leader_id ?? null,
  };
}

const qUserById = db.query(`${USER_SELECT} WHERE u.id = $id`);
const qUserByEmail = db.query(`${USER_SELECT} WHERE u.email = $email`);

export const userRowById = (id: number) => qUserById.get({ id }) as UserRow | null;

function usersByIds(ids: Iterable<number>) {
  const list = [...new Set(ids)];
  const out: Record<number, UserDTO> = {};
  if (!list.length) return out;
  const rows = db
    .query(`${USER_SELECT} WHERE u.id IN (SELECT value FROM json_each($ids))`)
    .all({ ids: JSON.stringify(list) }) as UserRow[];
  for (const r of rows) out[r.id] = toUser(r);
  return out;
}

// ---------------------------------------------------------------- identity

export type Viewer = { id: number; email: string; isAdmin: boolean; row: UserRow };

const qDirectoryMember = db.query("SELECT 1 FROM users WHERE email = $email AND active = 1 AND source IN ('lark', 'roster')");

// Allowed domains and admins, plus anyone active in the synced directory.
export function canSignIn(email: string) {
  email = email.toLowerCase();
  return isAllowedEmail(email) || Boolean(qDirectoryMember.get({ email }));
}

const touch = db.query("UPDATE users SET last_seen_at = $now WHERE id = $id");

export function resolveViewer(email: string): Viewer {
  email = email.toLowerCase();
  let row = qUserByEmail.get({ email }) as UserRow | null;
  const now = Date.now();
  if (!row) {
    // Someone logged in before the Lark sync knew about them; the next sync adopts
    // this row by email.
    const local = email.split("@")[0]!;
    db.query(
      `INSERT INTO users (email, name, source, active, created_at, updated_at, last_seen_at)
       VALUES ($email, $name, 'login', 1, $now, $now, $now)`,
    ).run({ email, name: local, now });
    row = qUserByEmail.get({ email }) as UserRow;
  } else if (!row.last_seen_at || now - row.last_seen_at > 5 * 60_000) {
    touch.run({ now, id: row.id });
  }
  return { id: row.id, email, isAdmin: ADMIN_EMAILS.has(email), row };
}

export function setLang(userId: number, lang: string) {
  if (lang !== "zh" && lang !== "en") throw new HttpError(400, "bad_lang");
  db.query("UPDATE users SET lang = $lang WHERE id = $id").run({ lang, id: userId });
}

// ---------------------------------------------------------------- directory

export function listUsers(viewer: Viewer) {
  const rows = db.query(`${USER_SELECT} WHERE u.active = 1 ORDER BY u.name COLLATE NOCASE`).all() as UserRow[];
  const counts: Record<number, number> = {};
  const received = db
    .query(
      `SELECT r.user_id AS id, COUNT(*) AS n FROM post_recipients r
       JOIN posts p ON p.id = r.post_id AND p.deleted_at IS NULL WHERE ${visibleTo("p")} GROUP BY r.user_id`,
    )
    .all({ viewer: viewer.id }) as { id: number; n: number }[];
  for (const r of received) counts[r.id] = r.n;
  const departments = db
    .query(
      `SELECT d.id, d.name, d.en_name AS enName, COUNT(u.id) AS members
       FROM departments d JOIN users u ON u.dept_id = d.id AND u.active = 1
       GROUP BY d.id ORDER BY members DESC, d.name`,
    )
    .all();
  return {
    users: rows.map((r) => ({ ...toUser(r), received: counts[r.id] ?? 0 })),
    departments,
  };
}

// ---------------------------------------------------------------- allowance

const qSpent = db.query(
  `SELECT COALESCE(SUM(cost), 0) AS spent FROM posts
   WHERE sender_id = $id AND period = $period AND kind = 'bonus' AND deleted_at IS NULL`,
);

export function allowance(userId: number, period = periodOf()) {
  const { spent } = qSpent.get({ id: userId, period }) as { spent: number };
  const total = config.bonus.monthlyAllowance;
  return { period, total, spent, remaining: Math.max(0, total - spent), resetsAt: periodBounds(period).end };
}

// ---------------------------------------------------------------- posts

// A private post is only visible to the people on it: the sender, recipients and CC.
// Binds $viewer.
function visibleTo(p: string) {
  return `(${p}.private = 0 OR ${p}.sender_id = $viewer
    OR EXISTS (SELECT 1 FROM post_recipients vr WHERE vr.post_id = ${p}.id AND vr.user_id = $viewer)
    OR EXISTS (SELECT 1 FROM post_cc vc WHERE vc.post_id = ${p}.id AND vc.user_id = $viewer))`;
}

type PostRow = {
  id: number;
  kind: "kudos" | "bonus";
  sender_id: number;
  message: string;
  value_tag: string | null;
  points: number;
  period: string;
  created_at: number;
  private: number;
};

export type PostDTO = {
  id: number;
  kind: "kudos" | "bonus";
  senderId: number;
  recipientIds: number[];
  ccIds: number[];
  message: string;
  valueTag: string | null;
  points: number;
  createdAt: number;
  private: boolean;
  reactions: { emoji: string; userIds: number[] }[];
  commentCount: number;
  canDelete: boolean;
};

function canDeletePost(p: PostRow, viewer: Viewer) {
  return viewer.isAdmin || (p.sender_id === viewer.id && p.period === periodOf());
}

function hydrate(rows: PostRow[], viewer: Viewer) {
  const ids = JSON.stringify(rows.map((r) => r.id));
  const recipients = db
    .query(`SELECT post_id, user_id FROM post_recipients WHERE post_id IN (SELECT value FROM json_each($ids)) ORDER BY rowid`)
    .all({ ids }) as { post_id: number; user_id: number }[];
  const cc = db
    .query(`SELECT post_id, user_id FROM post_cc WHERE post_id IN (SELECT value FROM json_each($ids)) ORDER BY rowid`)
    .all({ ids }) as { post_id: number; user_id: number }[];
  const reactions = db
    .query(
      `SELECT post_id, emoji, user_id FROM reactions
       WHERE post_id IN (SELECT value FROM json_each($ids)) ORDER BY created_at`,
    )
    .all({ ids }) as { post_id: number; emoji: string; user_id: number }[];
  const comments = db
    .query(
      `SELECT post_id, COUNT(*) AS n FROM comments
       WHERE post_id IN (SELECT value FROM json_each($ids)) AND deleted_at IS NULL GROUP BY post_id`,
    )
    .all({ ids }) as { post_id: number; n: number }[];

  const userIds = new Set<number>();
  const byPost = new Map<number, PostDTO>();
  const posts = rows.map((r) => {
    userIds.add(r.sender_id);
    const dto: PostDTO = {
      id: r.id,
      kind: r.kind,
      senderId: r.sender_id,
      recipientIds: [],
      ccIds: [],
      message: r.message,
      valueTag: r.value_tag,
      points: r.points,
      createdAt: r.created_at,
      private: r.private === 1,
      reactions: [],
      commentCount: 0,
      canDelete: canDeletePost(r, viewer),
    };
    byPost.set(r.id, dto);
    return dto;
  });
  for (const { post_id, user_id } of recipients) {
    byPost.get(post_id)!.recipientIds.push(user_id);
    userIds.add(user_id);
  }
  for (const { post_id, user_id } of cc) {
    byPost.get(post_id)!.ccIds.push(user_id);
    userIds.add(user_id);
  }
  for (const { post_id, emoji, user_id } of reactions) {
    const p = byPost.get(post_id)!;
    let group = p.reactions.find((g) => g.emoji === emoji);
    if (!group) p.reactions.push((group = { emoji, userIds: [] }));
    group.userIds.push(user_id);
    userIds.add(user_id);
  }
  for (const { post_id, n } of comments) byPost.get(post_id)!.commentCount = n;
  for (const p of posts) p.reactions.sort((a, b) => REACTIONS.indexOf(a.emoji as never) - REACTIONS.indexOf(b.emoji as never));
  return { posts, users: usersByIds(userIds) };
}

export type FeedQuery = {
  cursor?: number;
  limit?: number;
  kind?: string;
  tag?: string;
  userId?: number;
  role?: "received" | "sent" | "any";
  after?: number;
};

export function feed(q: FeedQuery, viewer: Viewer) {
  const where = ["p.deleted_at IS NULL", visibleTo("p")];
  const params: Record<string, string | number> = { viewer: viewer.id };
  if (q.cursor) (where.push("p.id < $cursor"), (params.cursor = q.cursor));
  if (q.after) (where.push("p.id > $after"), (params.after = q.after));
  if (q.kind === "kudos" || q.kind === "bonus") (where.push("p.kind = $kind"), (params.kind = q.kind));
  if (q.tag && isValueId(q.tag)) (where.push("p.value_tag = $tag"), (params.tag = q.tag));
  if (q.userId) {
    params.user = q.userId;
    const received = "EXISTS (SELECT 1 FROM post_recipients r WHERE r.post_id = p.id AND r.user_id = $user)";
    if (q.role === "received") where.push(received);
    else if (q.role === "sent") where.push("p.sender_id = $user");
    else where.push(`(p.sender_id = $user OR ${received})`);
  }
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
  params.limit = limit + 1;
  const rows = db
    .query(`SELECT p.* FROM posts p WHERE ${where.join(" AND ")} ORDER BY p.id DESC LIMIT $limit`)
    .all(params) as PostRow[];
  const page = rows.slice(0, limit);
  return { ...hydrate(page, viewer), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

const qPost = db.query(`SELECT p.* FROM posts p WHERE p.id = $id AND p.deleted_at IS NULL AND ${visibleTo("p")}`);

// Someone else's private post is indistinguishable from a missing one.
function livePost(id: number, viewer: Viewer) {
  const p = qPost.get({ id, viewer: viewer.id }) as PostRow | null;
  if (!p) throw new HttpError(404, "post_not_found");
  return p;
}

export function postDetail(id: number, viewer: Viewer) {
  const { posts, users } = hydrate([livePost(id, viewer)], viewer);
  const comments = db
    .query(
      `SELECT id, user_id AS userId, body, created_at AS createdAt FROM comments
       WHERE post_id = $id AND deleted_at IS NULL ORDER BY created_at`,
    )
    .all({ id }) as { id: number; userId: number; body: string; createdAt: number }[];
  Object.assign(users, usersByIds(comments.map((c) => c.userId)));
  return {
    post: posts[0]!,
    users,
    comments: comments.map((c) => ({ ...c, canDelete: viewer.isAdmin || c.userId === viewer.id })),
  };
}

export type NewPost = {
  kind: string;
  recipientIds: unknown;
  ccIds?: unknown;
  message: unknown;
  valueTag?: unknown;
  private?: unknown;
};

export function createPost(input: NewPost, viewer: Viewer) {
  const kind = input.kind === "bonus" ? "bonus" : input.kind === "kudos" ? "kudos" : null;
  if (!kind) throw new HttpError(400, "bad_kind");
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) throw new HttpError(400, "message_required");
  if (message.length > LIMITS.messageMax) throw new HttpError(400, "message_too_long");
  if (kind === "bonus" && message.length < LIMITS.messageMinBonus) throw new HttpError(400, "message_too_short");
  const valueTag = typeof input.valueTag === "string" && isValueId(input.valueTag) ? input.valueTag : null;

  const ids = Array.isArray(input.recipientIds) ? [...new Set(input.recipientIds.map(Number))] : [];
  if (!ids.length || ids.some((n) => !Number.isInteger(n))) throw new HttpError(400, "recipients_required");
  if (ids.length > LIMITS.recipientsMax) throw new HttpError(400, "too_many_recipients");
  // Kudos to yourself is fine; points to yourself are not.
  if (kind === "bonus" && ids.includes(viewer.id)) throw new HttpError(400, "no_self_bonus");
  const found = usersByIds(ids);
  if (ids.some((id) => !found[id]?.active)) throw new HttpError(400, "recipient_not_found");

  // CC'd people are only notified; anyone already a recipient is dropped. The sender may CC themselves.
  const ccIds = Array.isArray(input.ccIds) ? [...new Set(input.ccIds.map(Number))].filter((n) => !ids.includes(n)) : [];
  if (ccIds.some((n) => !Number.isInteger(n))) throw new HttpError(400, "cc_not_found");
  if (ccIds.length > LIMITS.ccMax) throw new HttpError(400, "too_many_cc");
  const ccFound = usersByIds(ccIds);
  if (ccIds.some((id) => !ccFound[id]?.active)) throw new HttpError(400, "cc_not_found");

  const isPrivate = input.private === true;
  const points = kind === "bonus" ? config.bonus.points : 0;
  const cost = points * ids.length;
  const now = Date.now();
  const period = periodOf(now);

  const id = db.transaction(() => {
    if (cost > 0 && allowance(viewer.id, period).remaining < cost) throw new HttpError(409, "insufficient_allowance");
    const res = db
      .query(
        `INSERT INTO posts (kind, sender_id, message, value_tag, points, cost, period, created_at, private)
         VALUES ($kind, $sender, $message, $tag, $points, $cost, $period, $now, $private)`,
      )
      .run({ kind, sender: viewer.id, message, tag: valueTag, points, cost, period, now, private: isPrivate ? 1 : 0 });
    const postId = Number(res.lastInsertRowid);
    const ins = db.query("INSERT INTO post_recipients (post_id, user_id) VALUES ($post, $user)");
    for (const u of ids) ins.run({ post: postId, user: u });
    const insCc = db.query("INSERT INTO post_cc (post_id, user_id) VALUES ($post, $user)");
    for (const u of ccIds) insCc.run({ post: postId, user: u });
    return postId;
  }).immediate();
  return id;
}

export function deletePost(id: number, viewer: Viewer) {
  const p = livePost(id, viewer);
  if (!canDeletePost(p, viewer)) throw new HttpError(403, "forbidden");
  db.query("UPDATE posts SET deleted_at = $now, deleted_by = $by WHERE id = $id").run({ now: Date.now(), by: viewer.id, id });
}

export function toggleReaction(postId: number, emoji: unknown, viewer: Viewer) {
  if (typeof emoji !== "string" || !REACTIONS.includes(emoji as never)) throw new HttpError(400, "bad_emoji");
  livePost(postId, viewer);
  const params = { post: postId, user: viewer.id, emoji };
  const del = db.query("DELETE FROM reactions WHERE post_id = $post AND user_id = $user AND emoji = $emoji").run(params);
  if (del.changes === 0) {
    db.query("INSERT INTO reactions (post_id, user_id, emoji, created_at) VALUES ($post, $user, $emoji, $now)").run({
      ...params,
      now: Date.now(),
    });
  }
  return hydrate([livePost(postId, viewer)], viewer);
}

export function addComment(postId: number, body: unknown, viewer: Viewer) {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw new HttpError(400, "comment_required");
  if (text.length > LIMITS.commentMax) throw new HttpError(400, "comment_too_long");
  livePost(postId, viewer);
  db.query("INSERT INTO comments (post_id, user_id, body, created_at) VALUES ($post, $user, $body, $now)").run({
    post: postId,
    user: viewer.id,
    body: text,
    now: Date.now(),
  });
  return postDetail(postId, viewer);
}

export function deleteComment(commentId: number, viewer: Viewer) {
  const c = db.query("SELECT post_id, user_id FROM comments WHERE id = $id AND deleted_at IS NULL").get({ id: commentId }) as
    | { post_id: number; user_id: number }
    | null;
  if (!c) throw new HttpError(404, "comment_not_found");
  livePost(c.post_id, viewer);
  if (!viewer.isAdmin && c.user_id !== viewer.id) throw new HttpError(403, "forbidden");
  db.query("UPDATE comments SET deleted_at = $now WHERE id = $id").run({ now: Date.now(), id: commentId });
  return postDetail(c.post_id, viewer);
}

// ---------------------------------------------------------------- stats

export const RANGES: Range[] = ["month", "quarter", "year", "all"];

// Admin-only totals, so private posts count; thanking yourself doesn't.
export function leaderboard(range: Range, type: "received" | "given") {
  const since = rangeStart(range);
  const rows =
    type === "received"
      ? db
          .query(
            `SELECT r.user_id AS userId, COUNT(*) AS count, SUM(p.points) AS points,
                    COUNT(DISTINCT p.sender_id) AS people
             FROM post_recipients r JOIN posts p ON p.id = r.post_id
             JOIN users u ON u.id = r.user_id AND u.active = 1
             WHERE p.deleted_at IS NULL AND p.created_at >= $since AND r.user_id <> p.sender_id
             GROUP BY r.user_id ORDER BY count DESC, points DESC, MAX(p.created_at) ASC LIMIT 50`,
          )
          .all({ since })
      : db
          .query(
            `SELECT p.sender_id AS userId, COUNT(*) AS count, SUM(p.cost) AS points,
                    (SELECT COUNT(DISTINCT r.user_id) FROM post_recipients r JOIN posts p2 ON p2.id = r.post_id
                     WHERE p2.sender_id = p.sender_id AND p2.deleted_at IS NULL AND p2.created_at >= $since
                       AND r.user_id <> p2.sender_id) AS people
             FROM posts p JOIN users u ON u.id = p.sender_id AND u.active = 1
             WHERE p.deleted_at IS NULL AND p.created_at >= $since
               AND EXISTS (SELECT 1 FROM post_recipients r WHERE r.post_id = p.id AND r.user_id <> p.sender_id)
             GROUP BY p.sender_id ORDER BY count DESC, people DESC, MAX(p.created_at) ASC LIMIT 50`,
          )
          .all({ since });
  const list = rows as { userId: number; count: number; points: number; people: number }[];
  return { rows: list, users: usersByIds(list.map((r) => r.userId)) };
}

export function overview() {
  const since = rangeStart("month");
  const month = db
    .query(
      `SELECT COUNT(*) AS posts, COALESCE(SUM(cost), 0) AS points FROM posts
       WHERE deleted_at IS NULL AND created_at >= $since`,
    )
    .get({ since }) as { posts: number; points: number };
  const { people } = db
    .query(
      `SELECT COUNT(*) AS people FROM (
         SELECT sender_id AS u FROM posts WHERE deleted_at IS NULL AND created_at >= $since
         UNION SELECT r.user_id FROM post_recipients r JOIN posts p ON p.id = r.post_id
               WHERE p.deleted_at IS NULL AND p.created_at >= $since)`,
    )
    .get({ since }) as { people: number };
  const { total } = db.query("SELECT COUNT(*) AS total FROM posts WHERE deleted_at IS NULL").get() as { total: number };

  // The hero constellation: who thanked whom, most recent first. Everyone sees the same graph,
  // so private posts stay out of it (the totals above are anonymous and include them).
  const edges = db
    .query(
      `SELECT p.id, p.sender_id AS source, r.user_id AS target, p.kind, p.created_at AS at
       FROM posts p JOIN post_recipients r ON r.post_id = p.id
       WHERE p.deleted_at IS NULL AND p.private = 0 AND r.user_id <> p.sender_id ORDER BY p.id DESC LIMIT 90`,
    )
    .all() as { id: number; source: number; target: number; kind: string; at: number }[];
  const nodeIds = new Set<number>();
  for (const e of edges) nodeIds.add(e.source).add(e.target);
  if (nodeIds.size < 24) {
    const extra = db
      .query("SELECT id FROM users WHERE active = 1 AND avatar_ver IS NOT NULL ORDER BY RANDOM() LIMIT $n")
      .all({ n: 24 - nodeIds.size }) as { id: number }[];
    for (const { id } of extra) nodeIds.add(id);
  }
  return {
    month: { ...month, people },
    total,
    graph: { nodes: [...nodeIds], edges },
    users: usersByIds(nodeIds),
  };
}

// Counted over the posts the viewer can see, so the numbers match the feeds below them.
export function profile(userId: number, viewer: Viewer) {
  const row = userRowById(userId);
  if (!row) throw new HttpError(404, "user_not_found");
  const params = { id: userId, viewer: viewer.id };
  const received = db
    .query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(p.points), 0) AS points,
              COUNT(DISTINCT CASE WHEN p.sender_id <> r.user_id THEN p.sender_id END) AS people
       FROM post_recipients r JOIN posts p ON p.id = r.post_id
       WHERE r.user_id = $id AND p.deleted_at IS NULL AND ${visibleTo("p")}`,
    )
    .get(params);
  const sent = db
    .query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(p.cost), 0) AS points FROM posts p
       WHERE p.sender_id = $id AND p.deleted_at IS NULL AND ${visibleTo("p")}`,
    )
    .get(params);
  const values = db
    .query(
      `SELECT p.value_tag AS tag, COUNT(*) AS count FROM post_recipients r JOIN posts p ON p.id = r.post_id
       WHERE r.user_id = $id AND p.deleted_at IS NULL AND p.value_tag IS NOT NULL AND ${visibleTo("p")}
       GROUP BY p.value_tag ORDER BY count DESC`,
    )
    .all(params);
  const supporters = db
    .query(
      `SELECT p.sender_id AS userId, COUNT(*) AS count FROM post_recipients r JOIN posts p ON p.id = r.post_id
       WHERE r.user_id = $id AND p.deleted_at IS NULL AND p.sender_id <> $id AND ${visibleTo("p")}
       GROUP BY p.sender_id ORDER BY count DESC, MAX(p.created_at) DESC LIMIT 8`,
    )
    .all(params) as { userId: number; count: number }[];
  const users = usersByIds([userId, ...supporters.map((s) => s.userId)]);
  return { user: users[userId]!, stats: { received, sent }, values, supporters, users };
}

// ---------------------------------------------------------------- admin

export function bonusReport(period: string) {
  const rows = db
    .query(
      `SELECT r.user_id AS userId, COUNT(*) AS count, SUM(p.points) AS points
       FROM post_recipients r JOIN posts p ON p.id = r.post_id
       WHERE p.kind = 'bonus' AND p.deleted_at IS NULL AND p.period = $period
       GROUP BY r.user_id ORDER BY points DESC`,
    )
    .all({ period }) as { userId: number; count: number; points: number }[];
  const users = usersByIds(rows.map((r) => r.userId));
  const emails = db
    .query("SELECT id, email FROM users WHERE id IN (SELECT value FROM json_each($ids))")
    .all({ ids: JSON.stringify(rows.map((r) => r.userId)) }) as { id: number; email: string | null }[];
  const emailById = Object.fromEntries(emails.map((e) => [e.id, e.email]));
  return { period, rows: rows.map((r) => ({ ...r, email: emailById[r.userId] ?? null })), users };
}

export function bonusPeriods() {
  return (db.query("SELECT DISTINCT period FROM posts WHERE kind = 'bonus' ORDER BY period DESC").all() as { period: string }[]).map(
    (r) => r.period,
  );
}

export function syncStatus() {
  const last = db.query("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get();
  const lastOk = db.query("SELECT * FROM sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1").get();
  const counts = db
    .query(
      `SELECT COUNT(*) AS total, SUM(active) AS active, SUM(source = 'lark' AND active = 1) AS lark,
              SUM(avatar_ver IS NOT NULL AND active = 1) AS withAvatar FROM users`,
    )
    .get();
  return { last, lastOk, counts };
}

export { isAllowedEmail };
