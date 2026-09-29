import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(join(config.dataDir, "kuakua.db"), { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

// Append-only list; index + 1 is the schema version stored in PRAGMA user_version.
const migrations = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    open_id TEXT UNIQUE,
    email TEXT UNIQUE,
    name TEXT NOT NULL,
    en_name TEXT,
    avatar_src TEXT,
    avatar_ver TEXT,
    dept_id TEXT,
    job_title TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'lark',
    lang TEXT,
    joined_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER
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
    deleted_by INTEGER
  );
  CREATE INDEX posts_created ON posts(created_at DESC);
  CREATE INDEX posts_sender_period ON posts(sender_id, period);
  CREATE TABLE post_recipients (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (post_id, user_id)
  );
  CREATE INDEX post_recipients_user ON post_recipients(user_id);
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
    error TEXT
  );
  `,
];

const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
for (let v = current; v < migrations.length; v++) {
  db.transaction(() => {
    db.exec(migrations[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  })();
}
