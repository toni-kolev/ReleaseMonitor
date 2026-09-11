import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.mjs";
import { DatabaseSync } from "node:sqlite";

test("shared watchlist and review state survive restart and repeated sync", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-monitor-"));
  const filename = join(directory, "feed.sqlite");
  let store = createStore(filename);
  try {
    store.add({ id: 1, fullName: "owner/project" });
    store.add({ id: 1, fullName: "owner/project" });
    const release = {
      id: 10,
      tag: "v1.0.0",
      publishedAt: "2026-09-01T00:00:00Z",
    };
    store.sync(1, [release], "etag");
    store.review(store.releases()[0].id, true);
    store.sync(1, [{ ...release, title: "Updated notes" }], "new-etag");
    store.close();
    store = createStore(filename);
    assert.equal(store.repositories().length, 1);
    assert.equal(store.releases()[0].reviewed, true);
    assert.equal(store.releases()[0].title, "Updated notes");
    store.fail(1, "Rate limited");
    assert.equal(store.releases().length, 1);
    store.sync(1, [], "new-etag");
    assert.equal(store.repositories()[0].error, null);
    store.remove(1);
    assert.equal(store.releases().length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider IDs and identical names coexist without sharing review state", () => {
  const store = createStore(":memory:");
  try {
    const github = store.add({ id: 1, fullName: "owner/project" });
    const codeberg = store.add({ id: 1, fullName: "owner/project", provider: "codeberg" });
    assert.notEqual(github.id, codeberg.id);
    const release = { id: 10, publishedAt: "2026-09-01T00:00:00Z" };
    store.sync(github.id, [release]);
    store.sync(codeberg.id, [release]);
    const githubRelease = store.releases().find((item) => item.repositoryId === github.id);
    store.review(githubRelease.id, true);
    store.sync(codeberg.id, [{ ...release, title: "Codeberg update" }]);
    assert.equal(store.releases().length, 2);
    assert.equal(store.releases().find((item) => item.repositoryId === codeberg.id).reviewed, false);
    store.remove(codeberg.id);
    assert.equal(store.releases()[0].reviewed, true);
    assert.equal(store.repositories()[0].provider, "github");
  } finally {
    store.close();
  }
});

test("legacy database migration preserves IDs, cached releases, ETags and review state", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-monitor-migration-"));
  const filename = join(directory, "feed.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      data TEXT NOT NULL, synced_at TEXT, error TEXT, etag TEXT);
    CREATE TABLE releases (id INTEGER PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      data TEXT NOT NULL, published_at TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0);
    INSERT INTO repositories VALUES (42, 'owner/project', '{"id":42,"fullName":"owner/project"}', '2026-09-01', NULL, 'cached');
    INSERT INTO releases VALUES (100, 42, '{"id":100,"tag":"v1.0.0"}', '2026-09-01', 1);
  `);
  legacy.close();
  let store = createStore(filename);
  try {
    assert.equal(store.repositories()[0].id, 42);
    assert.equal(store.repositories()[0].etag, "cached");
    assert.equal(store.repositories()[0].provider, "github");
    store.sync(42, [{ id: 100, tag: "v1.0.0", publishedAt: "2026-09-01" }], "cached");
    assert.equal(store.releases()[0].id, 100);
    assert.equal(store.releases()[0].reviewed, true);
    const codeberg = store.add({ id: 42, fullName: "owner/project", provider: "codeberg" });
    store.sync(codeberg.id, [{ id: 100, publishedAt: "2026-09-01" }]);
    store.close();
    store = createStore(filename);
    assert.equal(store.repositories().length, 2);
    assert.equal(store.releases().length, 2);
    store.remove(codeberg.id);
    assert.equal(store.releases()[0].id, 100);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
