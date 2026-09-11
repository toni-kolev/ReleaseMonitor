import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";
import { createApp } from "./app.mjs";
import { createGithub, releaseData } from "./github.mjs";
import { createCodeberg } from "./codeberg.mjs";

test("Codeberg adapter maps public repositories and paginated releases with optional authentication", async () => {
  const calls = [];
  const repo = { id: 1, full_name: "owner/project", owner: { avatar_url: "https://codeberg.org/avatar" }, stars_count: 12 };
  const release = { id: 10, tag_name: "v1.2.3", published_at: "2026-09-01T00:00:00Z", assets: [{ name: "app.zip", browser_download_url: "https://codeberg.org/download", size: 42 }] };
  const codeberg = createCodeberg({ token: "test-token", fetcher: async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.includes("/search?") ? { data: [repo, { ...repo, private: true }] }
      : url.includes("page=1") ? Array.from({ length: 50 }, (_, index) => ({ ...release, id: index + 1 }))
        : url.includes("page=2") ? [{ ...release, id: 51 }, { ...release, draft: true }]
          : repo);
  } });
  const results = await codeberg.search("owner project");
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, "codeberg");
  assert.equal(results[0].stars, 12);
  assert.match(calls[0].url, /q=owner%20project&limit=20/);
  assert.equal(calls[0].options.headers.Authorization, "token test-token");
  assert.equal(calls[0].options.headers["X-GitHub-Api-Version"], undefined);
  assert.equal((await codeberg.repository("owner/project")).fullName, "owner/project");
  const result = await codeberg.releases({ fullName: "owner/project" });
  assert.equal(result.releases.length, 51);
  assert.equal(result.releases[0].kind, "patch");
  assert.equal(result.releases[0].assets[0].size, 42);
  let requests = 0;
  const limited = createCodeberg({ fetcher: async (_, options) => {
    requests++;
    assert.equal(options.headers.Authorization, undefined);
    return new Response(null, { status: 429, headers: { "retry-after": "120" } });
  } });
  await assert.rejects(() => limited.search("test"), /rate limit/);
  await assert.rejects(() => limited.search("test"), /rate limit/);
  assert.equal(requests, 1);
});

test("Codeberg rejects private repositories and reports upstream failures", async () => {
  const privateRepo = createCodeberg({ fetcher: async () => Response.json({ private: true }) });
  await assert.rejects(() => privateRepo.repository("owner/private"), /Only public/);
  for (const [status, message, expectedStatus] of [
    [401, /Codeberg token is invalid/, 502],
    [404, /Public repository not found/, 404],
    [500, /Codeberg returned HTTP 500/, 502],
  ]) {
    const codeberg = createCodeberg({ fetcher: async () => new Response(null, { status }) });
    await assert.rejects(() => codeberg.repository("owner/project"), (error) => {
      assert.match(error.message, message);
      assert.equal(error.status, expectedStatus);
      return true;
    });
  }
  const offline = createCodeberg({ fetcher: async () => { throw new Error("Network error"); } });
  await assert.rejects(() => offline.search("project"), /Cached releases are still available/);
});

test("GitHub adapter handles public search, ETags, classification and rate limits", async () => {
  const calls = [];
  const github = createGithub({
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 304 });
    },
  });
  assert.deepEqual(
    await github.releases({ fullName: "owner/project", etag: "cached" }),
    { releases: [], etag: "cached" },
  );
  assert.equal(calls[0].options.headers["If-None-Match"], "cached");
  for (const [tag, kind] of [
    ["v2.0.0", "major"],
    ["v2.1.0", "minor"],
    ["v2.1.1", "patch"],
    ["v3.0.0-rc.1", "pre-release"],
    ["nightly", "other"],
  ]) {
    assert.equal(releaseData({ tag_name: tag }).kind, kind);
  }
  let requests = 0;
  const limited = createGithub({
    fetcher: async () => {
      requests++;
      return new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      });
    },
  });
  await assert.rejects(() => limited.search("react"), /rate limit/);
  await assert.rejects(() => limited.search("react"), /rate limit/);
  assert.equal(requests, 1);
});

test("API supports a shared feed, validates writes, and keeps cached releases on failure", async () => {
  const store = createStore(":memory:");
  const repo = { id: 1, fullName: "owner/project" };
  let failed = false;
  const github = {
    search: async () => [repo],
    repository: async () => repo,
    releases: async () => {
      if (failed) throw new Error("GitHub unavailable");
      return {
        releases: [
          { id: 10, tag: "v1.0.0", publishedAt: "2026-09-01T00:00:00Z" },
        ],
      };
    },
  };
  const { app, syncAll } = createApp({ store, github });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = "GET", body, headers = {}) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await request("/search?q=react")).status, 200);
    assert.equal(
      (await request("/repositories", "POST", { fullName: "../bad" })).status,
      400,
    );
    assert.equal(
      (
        await request(
          "/repositories",
          "POST",
          { fullName: "owner/project" },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await request("/repositories", "POST", { fullName: "owner/project" }))
        .status,
      201,
    );
    assert.equal(
      (await request("/repositories", "POST", { fullName: "owner/project" }))
        .status,
      200,
    );
    await request(`/releases/${store.releases()[0].id}`, "PATCH", { reviewed: true });
    let feed = await (await request("/feed")).json();
    assert.equal(feed.releases[0].reviewed, true);
    assert.equal(feed.repositories.length, 1);
    failed = true;
    await syncAll();
    feed = await (await request("/feed")).json();
    assert.equal(feed.releases.length, 1);
    assert.equal(feed.repositories[0].error, "GitHub unavailable");
    await request("/repositories/1", "DELETE", {});
    assert.equal((await (await request("/feed")).json()).releases.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("API routes both providers independently and rejects unknown providers", async () => {
  const store = createStore(":memory:");
  const repo = { id: 42, fullName: "owner/project" };
  const calls = [];
  let codebergOffline = false;
  const adapter = (provider) => ({
    search: async () => [{ ...repo, provider }],
    repository: async () => ({ ...repo, provider }),
    releases: async () => {
      calls.push(provider);
      if (provider === "codeberg" && codebergOffline) throw new Error("Codeberg unavailable");
      return { releases: [{ id: 10, publishedAt: "2026-09-01T00:00:00Z" }] };
    },
  });
  const { app, syncAll } = createApp({ store, github: adapter("github"), codeberg: adapter("codeberg") });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const add = (provider) => fetch(`${base}/repositories`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName: repo.fullName, provider }),
  });
  try {
    assert.equal((await fetch(`${base}/search?q=project&provider=unknown`)).status, 400);
    assert.equal((await add("unknown")).status, 400);
    const results = await (await fetch(`${base}/search?q=project&provider=codeberg`)).json();
    assert.equal(results.repositories[0].provider, "codeberg");
    assert.equal((await add("github")).status, 201);
    assert.equal((await add("codeberg")).status, 201);
    assert.equal((await add("codeberg")).status, 200);
    assert.equal(store.repositories().length, 2);
    assert.equal(store.releases().length, 2);
    assert.deepEqual(calls, ["github", "codeberg"]);
    await syncAll();
    assert.equal(calls.length, 4);
    assert.equal(store.releases().length, 2);
    codebergOffline = true;
    await syncAll();
    assert.equal(store.releases().length, 2);
    assert.equal(store.repositories().find((item) => item.provider === "codeberg").error, "Codeberg unavailable");
    assert.equal(store.repositories().find((item) => item.provider === "github").error, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
