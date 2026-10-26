import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyLocalMigrations, localSql } from "../../scripts/lib/local-d1.ts";

test("local migration history is preserved and a failed schema batch rolls back", () => {
  const state = mkdtempSync(join(tmpdir(), "kuakua-migration-"));
  const dir = join(state, "migrations");
  mkdirSync(dir);
  try {
    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep;me');");
    applyLocalMigrations(state, dir);
    applyLocalMigrations(state, dir);
    assert.deepEqual(localSql("SELECT value FROM sentinel", state)[0]?.results.rows, [["keep;me"]]);
    writeFileSync(join(dir, "0002_next.sql"), "CREATE TABLE next (id INTEGER); INSERT INTO nonexistent VALUES (1);");
    assert.throws(() => applyLocalMigrations(state, dir));
    assert.deepEqual(localSql("SELECT name FROM sqlite_master WHERE name = 'next'", state)[0]?.results.rows, []);
    assert.deepEqual(localSql("SELECT name FROM d1_migrations ORDER BY id", state)[0]?.results.rows, [["0001_first.sql"]]);
    writeFileSync(join(dir, "0002_next.sql"), "CREATE TABLE next (id INTEGER); INSERT INTO next VALUES (1);");
    applyLocalMigrations(state, dir);
    assert.deepEqual(localSql("SELECT name FROM d1_migrations ORDER BY id", state)[0]?.results.rows, [
      ["0001_first.sql"],
      ["0002_next.sql"],
    ]);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
