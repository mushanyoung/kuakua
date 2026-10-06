import { ADMIN_EMAILS, config, isAllowedEmail } from "./config";
import { db, q } from "./db";
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

export type UserRow = {
  id: number;
  open_id: string | null;
  email: string | null;
  name: string;
  en_name: string | null;
  avatar_ver: string | null;
  avatar_key: string | null;
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
  SELECT u.id, u.open_id, u.email, u.name, u.en_name, u.avatar_ver, u.avatar_key, u.dept_id, u.job_title,
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

export const userRowById = (id: number) => db.get<UserRow>(`${USER_SELECT} WHERE u.id = $id`, { id });

const usersByIdsQuery = (ids: Iterable<number>) =>
  q(`${USER_SELECT} WHERE u.id IN (SELECT value FROM json_each($ids))`, { ids: JSON.stringify([...new Set(ids)]) });

function toUsers(rows: UserRow[]) {
  const out: Record<number, UserDTO> = {};
  for (const r of rows) out[r.id] = toUser(r);
  return out;
}

async function usersByIds(ids: Iterable<number>) {
  const list = [...new Set(ids)];
  if (!list.length) return {};
  return toUsers((await usersByIdsQuery(list).all<UserRow>()).results);
}

// ---------------------------------------------------------------- identity

export type Viewer = { id: number; email: string; isAdmin: boolean; row: UserRow };

// Allowed domains and admins, plus anyone active in the synced directory.
export async function canSignIn(email: string) {
  email = email.toLowerCase();
  if (isAllowedEmail(email)) return true;
  return Boolean(
    await db.get("SELECT 1 AS ok FROM users WHERE email = $email AND active = 1 AND source IN ('lark', 'roster')", { email }),
  );
}

export async function resolveViewer(email: string): Promise<Viewer> {
  email = email.toLowerCase();
  const byEmail = () => db.get<UserRow>(`${USER_SELECT} WHERE u.email = $email`, { email });
  let row = await byEmail();
  const now = Date.now();
  if (!row) {
    // Someone signed in before the directory sync knew about them; the next sync adopts
    // this row by email.
    await db.run(
      `INSERT OR IGNORE INTO users (email, name, source, active, created_at, updated_at, last_seen_at)
       VALUES ($email, $name, 'login', 1, $now, $now, $now)`,
      { email, name: email.split("@")[0]!, now },
    );
    row = (await byEmail())!;
  } else if (!row.last_seen_at || now - row.last_seen_at > 5 * 60_000) {
    await db.run("UPDATE users SET last_seen_at = $now WHERE id = $id", { now, id: row.id });
  }
  return { id: row.id, email, isAdmin: ADMIN_EMAILS.has(email), row };
}

export async function setLang(userId: number, lang: string) {
  if (lang !== "zh" && lang !== "en") throw new HttpError(400, "bad_lang");
  await db.run("UPDATE users SET lang = $lang WHERE id = $id", { lang, id: userId });
}

// ---------------------------------------------------------------- directory

export async function listUsers(viewer: Viewer) {
  const [users, received, departments] = await db.batch([
    q(`${USER_SELECT} WHERE u.active = 1 ORDER BY u.name COLLATE NOCASE`),
    q(
      `SELECT r.user_id AS id, COUNT(*) AS n FROM post_recipients r
       JOIN posts p ON p.id = r.post_id AND p.deleted_at IS NULL WHERE ${visibleTo("p")} GROUP BY r.user_id`,
      { viewer: viewer.id },
    ),
    q(
      `SELECT d.id, d.name, d.en_name AS enName, COUNT(u.id) AS members
       FROM departments d JOIN users u ON u.dept_id = d.id AND u.active = 1
       GROUP BY d.id ORDER BY members DESC, d.name`,
    ),
  ]);
  const counts: Record<number, number> = {};
  for (const r of received!.results as { id: number; n: number }[]) counts[r.id] = r.n;
  return {
    users: (users!.results as UserRow[]).map((r) => ({ ...toUser(r), received: counts[r.id] ?? 0 })),
    departments: departments!.results,
  };
}

// ---------------------------------------------------------------- allowance

export async function allowance(userId: number, period = periodOf()) {
  const row = await db.get<{ spent: number }>(
    `SELECT COALESCE(SUM(cost), 0) AS spent FROM posts
     WHERE sender_id = $id AND period = $period AND kind = 'bonus' AND deleted_at IS NULL`,
    { id: userId, period },
  );
  const spent = row?.spent ?? 0;
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

async function hydrate(rows: PostRow[], viewer: Viewer, extraUserIds: number[] = []) {
  const ids = JSON.stringify(rows.map((r) => r.id));
  const inPosts = "post_id IN (SELECT value FROM json_each($ids))";
  // Every user mentioned by these posts, in the same round trip as the posts' details.
  const people = `SELECT sender_id FROM posts WHERE id IN (SELECT value FROM json_each($ids))
    UNION SELECT user_id FROM post_recipients WHERE ${inPosts}
    UNION SELECT user_id FROM post_cc WHERE ${inPosts}
    UNION SELECT user_id FROM reactions WHERE ${inPosts}
    UNION SELECT value FROM json_each($extra)`;
  const [recipients, cc, reactions, comments, users] = await db.batch([
    q(`SELECT post_id, user_id FROM post_recipients WHERE ${inPosts} ORDER BY rowid`, { ids }),
    q(`SELECT post_id, user_id FROM post_cc WHERE ${inPosts} ORDER BY rowid`, { ids }),
    q(`SELECT post_id, emoji, user_id FROM reactions WHERE ${inPosts} ORDER BY created_at`, { ids }),
    q(`SELECT post_id, COUNT(*) AS n FROM comments WHERE ${inPosts} AND deleted_at IS NULL GROUP BY post_id`, { ids }),
    q(`${USER_SELECT} WHERE u.id IN (${people})`, { ids, extra: JSON.stringify(extraUserIds) }),
  ]);

  const byPost = new Map<number, PostDTO>();
  const posts = rows.map((r) => {
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
  for (const { post_id, user_id } of recipients!.results as { post_id: number; user_id: number }[]) {
    byPost.get(post_id)!.recipientIds.push(user_id);
  }
  for (const { post_id, user_id } of cc!.results as { post_id: number; user_id: number }[]) byPost.get(post_id)!.ccIds.push(user_id);
  for (const { post_id, emoji, user_id } of reactions!.results as { post_id: number; emoji: string; user_id: number }[]) {
    const p = byPost.get(post_id)!;
    let group = p.reactions.find((g) => g.emoji === emoji);
    if (!group) p.reactions.push((group = { emoji, userIds: [] }));
    group.userIds.push(user_id);
  }
  for (const { post_id, n } of comments!.results as { post_id: number; n: number }[]) byPost.get(post_id)!.commentCount = n;
  for (const p of posts) p.reactions.sort((a, b) => REACTIONS.indexOf(a.emoji as never) - REACTIONS.indexOf(b.emoji as never));
  return { posts, users: toUsers(users!.results as UserRow[]) };
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

export async function feed(fq: FeedQuery, viewer: Viewer) {
  const where = ["p.deleted_at IS NULL", visibleTo("p")];
  const params: Record<string, string | number> = { viewer: viewer.id };
  if (fq.cursor) (where.push("p.id < $cursor"), (params.cursor = fq.cursor));
  if (fq.after) (where.push("p.id > $after"), (params.after = fq.after));
  if (fq.kind === "kudos" || fq.kind === "bonus") (where.push("p.kind = $kind"), (params.kind = fq.kind));
  if (fq.tag && isValueId(fq.tag)) (where.push("p.value_tag = $tag"), (params.tag = fq.tag));
  if (fq.userId) {
    params.user = fq.userId;
    const received = "EXISTS (SELECT 1 FROM post_recipients r WHERE r.post_id = p.id AND r.user_id = $user)";
    if (fq.role === "received") where.push(received);
    else if (fq.role === "sent") where.push("p.sender_id = $user");
    else where.push(`(p.sender_id = $user OR ${received})`);
  }
  const limit = Math.min(Math.max(fq.limit ?? 20, 1), 50);
  params.limit = limit + 1;
  const rows = await db.all<PostRow>(`SELECT p.* FROM posts p WHERE ${where.join(" AND ")} ORDER BY p.id DESC LIMIT $limit`, params);
  const page = rows.slice(0, limit);
  return { ...(await hydrate(page, viewer)), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

// Someone else's private post is indistinguishable from a missing one.
async function livePost(id: number, viewer: Viewer) {
  const p = await db.get<PostRow>(`SELECT p.* FROM posts p WHERE p.id = $id AND p.deleted_at IS NULL AND ${visibleTo("p")}`, {
    id,
    viewer: viewer.id,
  });
  if (!p) throw new HttpError(404, "post_not_found");
  return p;
}

type CommentRow = { id: number; userId: number; body: string; createdAt: number };

export async function postDetail(id: number, viewer: Viewer) {
  const post = await livePost(id, viewer);
  const comments = await db.all<CommentRow>(
    `SELECT id, user_id AS userId, body, created_at AS createdAt FROM comments
     WHERE post_id = $id AND deleted_at IS NULL ORDER BY created_at`,
    { id },
  );
  const { posts, users } = await hydrate(
    [post],
    viewer,
    comments.map((c) => c.userId),
  );
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

export async function createPost(input: NewPost, viewer: Viewer) {
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

  // CC'd people are only notified; anyone already a recipient is dropped. The sender may CC themselves.
  const ccIds = Array.isArray(input.ccIds) ? [...new Set(input.ccIds.map(Number))].filter((n) => !ids.includes(n)) : [];
  if (ccIds.some((n) => !Number.isInteger(n))) throw new HttpError(400, "cc_not_found");
  if (ccIds.length > LIMITS.ccMax) throw new HttpError(400, "too_many_cc");

  const found = await usersByIds([...ids, ...ccIds]);
  if (ids.some((id) => !found[id]?.active)) throw new HttpError(400, "recipient_not_found");
  if (ccIds.some((id) => !found[id]?.active)) throw new HttpError(400, "cc_not_found");

  const points = kind === "bonus" ? config.bonus.points : 0;
  const cost = points * ids.length;
  const now = Date.now();
  const period = periodOf(now);

  // One atomic batch. The post is only inserted if the sender still has the allowance;
  // recipients and CC attach to "this sender's post created at $now", so they're skipped
  // too when it wasn't.
  const params = { sender: viewer.id, now };
  const thisPost = "(SELECT id FROM posts WHERE sender_id = $sender AND created_at = $now ORDER BY id DESC LIMIT 1)";
  const [inserted] = await db.batch([
    q(
      `INSERT INTO posts (kind, sender_id, message, value_tag, points, cost, period, created_at, private)
       SELECT $kind, $sender, $message, $tag, $points, $cost, $period, $now, $private
       WHERE $cost = 0 OR (
         SELECT COALESCE(SUM(cost), 0) FROM posts
         WHERE sender_id = $sender AND period = $period AND kind = 'bonus' AND deleted_at IS NULL
       ) + $cost <= $allowance
       RETURNING id`,
      {
        ...params,
        kind,
        message,
        tag: valueTag,
        points,
        cost,
        period,
        private: input.private === true,
        allowance: config.bonus.monthlyAllowance,
      },
    ),
    q(`INSERT INTO post_recipients (post_id, user_id) SELECT ${thisPost}, value FROM json_each($ids) WHERE ${thisPost} IS NOT NULL`, {
      ...params,
      ids: JSON.stringify(ids),
    }),
    q(`INSERT INTO post_cc (post_id, user_id) SELECT ${thisPost}, value FROM json_each($ids) WHERE ${thisPost} IS NOT NULL`, {
      ...params,
      ids: JSON.stringify(ccIds),
    }),
  ]);
  const id = (inserted!.results[0] as { id: number } | undefined)?.id;
  if (!id) throw new HttpError(409, "insufficient_allowance");
  return id;
}

export async function deletePost(id: number, viewer: Viewer) {
  const p = await livePost(id, viewer);
  if (!canDeletePost(p, viewer)) throw new HttpError(403, "forbidden");
  await db.run("UPDATE posts SET deleted_at = $now, deleted_by = $by WHERE id = $id", { now: Date.now(), by: viewer.id, id });
}

export async function toggleReaction(postId: number, emoji: unknown, viewer: Viewer) {
  if (typeof emoji !== "string" || !REACTIONS.includes(emoji as never)) throw new HttpError(400, "bad_emoji");
  const post = await livePost(postId, viewer);
  const params = { post: postId, user: viewer.id, emoji };
  const removed = await db.run("DELETE FROM reactions WHERE post_id = $post AND user_id = $user AND emoji = $emoji", params);
  if (removed.changes === 0) {
    await db.run(
      "INSERT OR IGNORE INTO reactions (post_id, user_id, emoji, created_at) VALUES ($post, $user, $emoji, $now)",
      { ...params, now: Date.now() },
    );
  }
  return hydrate([post], viewer);
}

export async function addComment(postId: number, body: unknown, viewer: Viewer) {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw new HttpError(400, "comment_required");
  if (text.length > LIMITS.commentMax) throw new HttpError(400, "comment_too_long");
  await livePost(postId, viewer);
  await db.run("INSERT INTO comments (post_id, user_id, body, created_at) VALUES ($post, $user, $body, $now)", {
    post: postId,
    user: viewer.id,
    body: text,
    now: Date.now(),
  });
  return postDetail(postId, viewer);
}

export async function deleteComment(commentId: number, viewer: Viewer) {
  const c = await db.get<{ post_id: number; user_id: number }>(
    "SELECT post_id, user_id FROM comments WHERE id = $id AND deleted_at IS NULL",
    { id: commentId },
  );
  if (!c) throw new HttpError(404, "comment_not_found");
  await livePost(c.post_id, viewer);
  if (!viewer.isAdmin && c.user_id !== viewer.id) throw new HttpError(403, "forbidden");
  await db.run("UPDATE comments SET deleted_at = $now WHERE id = $id", { now: Date.now(), id: commentId });
  return postDetail(c.post_id, viewer);
}

// ---------------------------------------------------------------- stats

export const RANGES: Range[] = ["month", "quarter", "year", "all"];

// Admin-only totals, so private posts count; thanking yourself doesn't.
export async function leaderboard(range: Range, type: "received" | "given") {
  const since = rangeStart(range);
  const rows =
    type === "received"
      ? await db.all<LeaderRow>(
          `SELECT r.user_id AS userId, COUNT(*) AS count, SUM(p.points) AS points,
                  COUNT(DISTINCT p.sender_id) AS people
           FROM post_recipients r JOIN posts p ON p.id = r.post_id
           JOIN users u ON u.id = r.user_id AND u.active = 1
           WHERE p.deleted_at IS NULL AND p.created_at >= $since AND r.user_id <> p.sender_id
           GROUP BY r.user_id ORDER BY count DESC, points DESC, MAX(p.created_at) ASC LIMIT 50`,
          { since },
        )
      : await db.all<LeaderRow>(
          `SELECT p.sender_id AS userId, COUNT(*) AS count, SUM(p.cost) AS points,
                  (SELECT COUNT(DISTINCT r.user_id) FROM post_recipients r JOIN posts p2 ON p2.id = r.post_id
                   WHERE p2.sender_id = p.sender_id AND p2.deleted_at IS NULL AND p2.created_at >= $since
                     AND r.user_id <> p2.sender_id) AS people
           FROM posts p JOIN users u ON u.id = p.sender_id AND u.active = 1
           WHERE p.deleted_at IS NULL AND p.created_at >= $since
             AND EXISTS (SELECT 1 FROM post_recipients r WHERE r.post_id = p.id AND r.user_id <> p.sender_id)
           GROUP BY p.sender_id ORDER BY count DESC, people DESC, MAX(p.created_at) ASC LIMIT 50`,
          { since },
        );
  return { rows, users: await usersByIds(rows.map((r) => r.userId)) };
}
type LeaderRow = { userId: number; count: number; points: number; people: number };

export async function overview() {
  const since = rangeStart("month");
  const [month, people, total, edges] = await db.batch([
    q(
      `SELECT COUNT(*) AS posts, COALESCE(SUM(cost), 0) AS points FROM posts
       WHERE deleted_at IS NULL AND created_at >= $since`,
      { since },
    ),
    q(
      `SELECT COUNT(*) AS people FROM (
         SELECT sender_id AS u FROM posts WHERE deleted_at IS NULL AND created_at >= $since
         UNION SELECT r.user_id FROM post_recipients r JOIN posts p ON p.id = r.post_id
               WHERE p.deleted_at IS NULL AND p.created_at >= $since)`,
      { since },
    ),
    q("SELECT COUNT(*) AS total FROM posts WHERE deleted_at IS NULL"),
    // The hero constellation: who thanked whom, most recent first. Everyone sees the same graph,
    // so private posts stay out of it (the totals above are anonymous and include them).
    q(
      `SELECT p.id, p.sender_id AS source, r.user_id AS target, p.kind, p.created_at AS at
       FROM posts p JOIN post_recipients r ON r.post_id = p.id
       WHERE p.deleted_at IS NULL AND p.private = 0 AND r.user_id <> p.sender_id ORDER BY p.id DESC LIMIT 90`,
    ),
  ]);
  const graph = edges!.results as { id: number; source: number; target: number; kind: string; at: number }[];
  const nodeIds = new Set<number>();
  for (const e of graph) nodeIds.add(e.source).add(e.target);
  if (nodeIds.size < 24) {
    const extra = await db.all<{ id: number }>(
      "SELECT id FROM users WHERE active = 1 AND avatar_ver IS NOT NULL ORDER BY RANDOM() LIMIT $n",
      { n: 24 - nodeIds.size },
    );
    for (const { id } of extra) nodeIds.add(id);
  }
  const m = month!.results[0] as { posts: number; points: number };
  return {
    month: { ...m, people: (people!.results[0] as { people: number }).people },
    total: (total!.results[0] as { total: number }).total,
    graph: { nodes: [...nodeIds], edges: graph },
    users: await usersByIds(nodeIds),
  };
}

// Counted over the posts the viewer can see, so the numbers match the feeds below them.
export async function profile(userId: number, viewer: Viewer) {
  const params = { id: userId, viewer: viewer.id };
  const [received, sent, values, supporters] = await db.batch([
    q(
      `SELECT COUNT(*) AS count, COALESCE(SUM(p.points), 0) AS points,
              COUNT(DISTINCT CASE WHEN p.sender_id <> r.user_id THEN p.sender_id END) AS people
       FROM post_recipients r JOIN posts p ON p.id = r.post_id
       WHERE r.user_id = $id AND p.deleted_at IS NULL AND ${visibleTo("p")}`,
      params,
    ),
    q(
      `SELECT COUNT(*) AS count, COALESCE(SUM(p.cost), 0) AS points FROM posts p
       WHERE p.sender_id = $id AND p.deleted_at IS NULL AND ${visibleTo("p")}`,
      params,
    ),
    q(
      `SELECT p.value_tag AS tag, COUNT(*) AS count FROM post_recipients r JOIN posts p ON p.id = r.post_id
       WHERE r.user_id = $id AND p.deleted_at IS NULL AND p.value_tag IS NOT NULL AND ${visibleTo("p")}
       GROUP BY p.value_tag ORDER BY count DESC`,
      params,
    ),
    q(
      `SELECT p.sender_id AS userId, COUNT(*) AS count FROM post_recipients r JOIN posts p ON p.id = r.post_id
       WHERE r.user_id = $id AND p.deleted_at IS NULL AND p.sender_id <> $id AND ${visibleTo("p")}
       GROUP BY p.sender_id ORDER BY count DESC, MAX(p.created_at) DESC LIMIT 8`,
      params,
    ),
  ]);
  const backers = supporters!.results as { userId: number; count: number }[];
  const users = await usersByIds([userId, ...backers.map((s) => s.userId)]);
  if (!users[userId]) throw new HttpError(404, "user_not_found");
  return {
    user: users[userId],
    stats: { received: received!.results[0], sent: sent!.results[0] },
    values: values!.results,
    supporters: backers,
    users,
  };
}

// ---------------------------------------------------------------- admin

export async function bonusReport(period: string) {
  const rows = await db.all<{ userId: number; count: number; points: number; email: string | null }>(
    `SELECT r.user_id AS userId, COUNT(*) AS count, SUM(p.points) AS points, u.email
     FROM post_recipients r JOIN posts p ON p.id = r.post_id JOIN users u ON u.id = r.user_id
     WHERE p.kind = 'bonus' AND p.deleted_at IS NULL AND p.period = $period
     GROUP BY r.user_id ORDER BY points DESC`,
    { period },
  );
  return { period, rows, users: await usersByIds(rows.map((r) => r.userId)) };
}

export async function bonusPeriods() {
  const rows = await db.all<{ period: string }>("SELECT DISTINCT period FROM posts WHERE kind = 'bonus' ORDER BY period DESC");
  return rows.map((r) => r.period);
}

export async function syncStatus() {
  const [last, lastOk, counts] = await db.batch([
    q("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1"),
    q("SELECT * FROM sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1"),
    q(
      `SELECT COUNT(*) AS total, SUM(active) AS active, SUM(source = 'lark' AND active = 1) AS lark,
              SUM(avatar_ver IS NOT NULL AND active = 1) AS withAvatar FROM users`,
    ),
  ]);
  return { last: last!.results[0] ?? null, lastOk: lastOk!.results[0] ?? null, counts: counts!.results[0] };
}
