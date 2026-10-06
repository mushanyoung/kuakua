-- D1 schema. Applied by `wrangler d1 migrations apply`; add new files, never edit applied ones.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id TEXT UNIQUE,
  email TEXT UNIQUE,
  name TEXT NOT NULL,
  en_name TEXT,
  -- Where the avatar came from (Lark URL, roster path or URL), its version, and the R2 key
  -- of the 240px image ("-240" → "-640" for the large one when that exists).
  avatar_src TEXT,
  avatar_ver TEXT,
  avatar_key TEXT,
  dept_id TEXT,
  job_title TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'lark',
  lang TEXT,
  joined_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  leader_open_id TEXT,
  leader_email TEXT
);

CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  en_name TEXT,
  parent_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('kudos', 'bonus')),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  value_tag TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  period TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by INTEGER,
  private INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX posts_created ON posts(created_at DESC);
CREATE INDEX posts_sender_period ON posts(sender_id, period);

CREATE TABLE post_recipients (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_recipients_user ON post_recipients(user_id);

CREATE TABLE post_cc (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE reactions (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id, emoji)
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX comments_post ON comments(post_id, created_at);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  users_seen INTEGER,
  users_active INTEGER,
  avatars_updated INTEGER,
  error TEXT,
  warnings TEXT,
  -- Roster only: the R2 etag of the roster file this run read.
  source_ref TEXT
);
