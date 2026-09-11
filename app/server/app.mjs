import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { resolve } from "node:path";
import { ApiError } from "./github.mjs";

export function createApp({
  store,
  github,
  codeberg,
  intervalMinutes = 60,
  dist = resolve("dist"),
}) {
  const app = express();
  let syncing = false;
  const inFlight = new Map();
  let lastRefresh = 0;
  function client(provider = "github") {
    if (provider === "github" && github) return github;
    if (provider === "codeberg" && codeberg) return codeberg;
    throw new ApiError("Choose GitHub or Codeberg as the provider.", 400);
  }
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "https:", "data:"],
          "upgrade-insecure-requests": null,
        },
      },
      strictTransportSecurity: false,
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method)) {
      if (!req.is("application/json"))
        return res
          .status(415)
          .json({ error: "Content-Type must be application/json." });
      if (
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      )
        return res
          .status(403)
          .json({ error: "Cross-origin writes are not allowed." });
    }
    next();
  });
  app.use(express.json({ limit: "8kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Retry in a minute." },
    }),
  );
  const searchLimit = rateLimit({
    windowMs: 60000,
    limit: 10,
    message: { error: "Search limit reached. Retry in a minute." },
  });
  const writeLimit = rateLimit({
    windowMs: 60000,
    limit: 20,
    message: { error: "Too many changes. Retry in a minute." },
  });

  async function syncRepository(repo) {
    if (inFlight.has(repo.id)) return inFlight.get(repo.id);
    const task = (async () => {
      try {
        const result = await client(repo.provider).releases(repo);
        if (store.repositories().some((current) => current.id === repo.id))
          store.sync(repo.id, result.releases, result.etag);
      } catch (error) {
        store.fail(repo.id, error.message);
      } finally {
        inFlight.delete(repo.id);
      }
    })();
    inFlight.set(repo.id, task);
    return task;
  }

  async function syncAll() {
    if (syncing) return;
    syncing = true;
    try {
      for (const repo of store.repositories()) await syncRepository(repo);
    } finally {
      syncing = false;
    }
  }

  app.get("/api/health", (req, res) => res.json({ status: "ok" }));
  app.get("/api/feed", (req, res) =>
    res.json({
      repositories: store
        .repositories()
        .map(({ etag: _etag, ...repo }) => repo),
      releases: store.releases(),
      syncing,
      intervalMinutes,
    }),
  );
  app.get("/api/search", searchLimit, async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2 || query.length > 120)
      throw new ApiError("Enter between 2 and 120 characters.", 400);
    res.json({ repositories: await client(req.query.provider).search(query) });
  });
  app.post("/api/repositories", writeLimit, async (req, res) => {
    const fullName = req.body?.fullName;
    const provider = req.body?.provider ?? "github";
    const source = client(provider);
    const namePattern = provider === "codeberg"
      ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9_.-]{1,100}$/
      : /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/;
    if (
      typeof fullName !== "string" ||
      !namePattern.test(fullName) ||
      [".", ".."].includes(fullName.split("/")[1])
    ) {
      throw new ApiError("Use a valid owner/repository name.", 400);
    }
    if (
      store
        .repositories()
        .some((repo) => repo.provider === provider && repo.fullName.toLowerCase() === fullName.toLowerCase())
    )
      return res.status(200).json({ added: false });
    if (store.repositories().length >= 50)
      throw new ApiError(
        "The shared watchlist is limited to 50 repositories.",
        400,
      );
    const remote = await source.repository(fullName);
    if (store.repositories().length >= 50)
      throw new ApiError(
        "The shared watchlist is limited to 50 repositories.",
        400,
      );
    const repo = store.add({ ...remote, provider });
    await syncRepository(repo);
    res.status(201).json({ added: true, repository: repo });
  });
  app.delete("/api/repositories/:id", writeLimit, (req, res) => {
    store.remove(validId(req.params.id));
    res.json({ removed: true });
  });
  app.patch("/api/releases/:id", writeLimit, (req, res) => {
    if (typeof req.body?.reviewed !== "boolean")
      throw new ApiError("reviewed must be a boolean.", 400);
    store.review(validId(req.params.id), req.body.reviewed);
    res.json({ updated: true });
  });
  app.post("/api/review-all", writeLimit, (req, res) => {
    store.reviewAll();
    res.json({ updated: true });
  });
  app.post("/api/sync", writeLimit, (req, res) => {
    if (Date.now() - lastRefresh < 60000 || syncing)
      throw new ApiError(
        "Sync is running or was just requested. Retry in a minute.",
        429,
      );
    lastRefresh = Date.now();
    void syncAll();
    res.status(202).json({ syncing: true });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use(express.static(dist));
  app.get("/{*path}", (req, res) => res.sendFile(resolve(dist, "index.html")));
  app.use((error, req, res, _next) => {
    const status =
      error instanceof ApiError
        ? error.status
        : error.status === 400
          ? 400
          : 500;
    if (status === 500) console.error(error);
    res
      .status(status)
      .json({
        error:
          status === 500
            ? "An unexpected server error occurred."
            : error.message,
      });
  });
  return { app, syncAll };
}

function validId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new ApiError("Invalid ID.", 400);
  return id;
}
