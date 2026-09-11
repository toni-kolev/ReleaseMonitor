import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createStore(filename) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY, full_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      data TEXT NOT NULL, synced_at TEXT, error TEXT, etag TEXT
    );
    CREATE TABLE IF NOT EXISTS releases (
      id INTEGER PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      data TEXT NOT NULL, published_at TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0
    );
  `);
  if (db.prepare("PRAGMA user_version").get().user_version < 1) {
    db.exec(`
      BEGIN;
      CREATE TABLE repositories_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL, remote_id INTEGER NOT NULL,
        full_name TEXT NOT NULL COLLATE NOCASE,
        data TEXT NOT NULL, synced_at TEXT, error TEXT, etag TEXT,
        UNIQUE(provider, remote_id), UNIQUE(provider, full_name)
      );
      INSERT INTO repositories_next
        SELECT id, 'github', id, full_name, data, synced_at, error, etag FROM repositories;
      CREATE TABLE releases_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_id INTEGER NOT NULL REFERENCES repositories_next(id) ON DELETE CASCADE,
        remote_id INTEGER NOT NULL, data TEXT NOT NULL, published_at TEXT NOT NULL,
        reviewed INTEGER NOT NULL DEFAULT 0, UNIQUE(repository_id, remote_id)
      );
      INSERT INTO releases_next
        SELECT id, repository_id, id, data, published_at, reviewed FROM releases;
      DROP TABLE releases;
      DROP TABLE repositories;
      ALTER TABLE repositories_next RENAME TO repositories;
      ALTER TABLE releases_next RENAME TO releases;
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  return {
    close: () => db.close(),
    repositories: () =>
      db
        .prepare("SELECT * FROM repositories ORDER BY full_name")
        .all()
        .map((row) => ({
          ...JSON.parse(row.data),
          id: row.id,
          provider: row.provider,
          remoteId: row.remote_id,
          syncedAt: row.synced_at,
          error: row.error,
          etag: row.etag,
        })),
    add: (repo) => {
      const provider = repo.provider ?? "github";
      db
        .prepare(
          "INSERT OR IGNORE INTO repositories (provider, remote_id, full_name, data) VALUES (?, ?, ?, ?)",
        )
        .run(provider, repo.id, repo.fullName, JSON.stringify(repo));
      const row = db.prepare("SELECT id FROM repositories WHERE provider = ? AND remote_id = ?")
        .get(provider, repo.id);
      return { ...repo, id: row.id, remoteId: repo.id, provider };
    },
    remove: (id) => db.prepare("DELETE FROM repositories WHERE id = ?").run(id),
    sync: (id, releases, etag) => {
      db.exec("BEGIN");
      try {
        const insert =
          db.prepare(`INSERT INTO releases (remote_id, repository_id, data, published_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(repository_id, remote_id) DO UPDATE SET data = excluded.data, published_at = excluded.published_at`);
        for (const release of releases)
          insert.run(
            release.id,
            id,
            JSON.stringify(release),
            release.publishedAt,
          );
        db.prepare(
          "UPDATE repositories SET synced_at = ?, error = NULL, etag = ? WHERE id = ?",
        ).run(new Date().toISOString(), etag ?? null, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    fail: (id, message) =>
      db
        .prepare("UPDATE repositories SET error = ? WHERE id = ?")
        .run(message, id),
    releases: () =>
      db
        .prepare("SELECT * FROM releases ORDER BY published_at DESC, id DESC")
        .all()
        .map((row) => ({
          ...JSON.parse(row.data),
          id: row.id,
          repositoryId: row.repository_id,
          reviewed: Boolean(row.reviewed),
        })),
    review: (id, reviewed) =>
      db
        .prepare("UPDATE releases SET reviewed = ? WHERE id = ?")
        .run(Number(reviewed), id),
    reviewAll: () => db.prepare("UPDATE releases SET reviewed = 1").run(),
  };
}
