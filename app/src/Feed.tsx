import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Kind = "major" | "minor" | "patch" | "pre-release" | "other";
type Provider = "github" | "gitlab" | "codeberg";
const providers = {
  github: { label: "GitHub", icon: "github" },
  gitlab: { label: "GitLab", icon: "gitlab" },
  codeberg: { label: "Codeberg", icon: "git" },
} as const;

function repositoryName(fullName: string) {
  const segments = fullName.split("/");
  return {
    owner: segments.slice(0, -1).join("/"),
    name: segments.at(-1) ?? fullName,
  };
}
type Repository = {
  id: number;
  provider: Provider;
  fullName: string;
  description: string;
  avatarUrl: string;
  url: string;
  stars: number;
  language: string | null;
  syncedAt: string | null;
  error: string | null;
};
type Release = {
  id: number;
  repositoryId: number;
  tag: string;
  title: string;
  body: string;
  url: string;
  publishedAt: string;
  author: string;
  kind: Kind;
  reviewed: boolean;
  assets: { name: string; url: string; size: number }[];
};
type Feed = {
  repositories: Repository[];
  releases: Release[];
  syncing: boolean;
  intervalMinutes: number;
};
const filters = [
  "all",
  "major",
  "minor",
  "patch",
  "pre-release",
  "other",
] as const;
const number = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Request failed. Please try again.");
  return data;
}

function ago(value: string | null) {
  if (!value) return "Not yet synced";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const savedTheme = window.localStorage.getItem("theme");
    if (savedTheme === "light" || savedTheme === "dark") return savedTheme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState("");
  const [adding, setAdding] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<number | null>(null);
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [sort, setSort] = useState("newest");
  const [visible, setVisible] = useState(20);
  const [showScrollToTop, setShowScrollToTop] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const updateScrollToTop = () => setShowScrollToTop(window.scrollY > 400);
    updateScrollToTop();
    window.addEventListener("scroll", updateScrollToTop, { passive: true });
    return () => window.removeEventListener("scroll", updateScrollToTop);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const result = await api<Feed>("/feed", { signal: controller.signal });
        setFeed(result);
        setError("");
      } catch (problem) {
        if (!controller.signal.aborted)
          setError(
            problem instanceof Error
              ? problem.message
              : "Could not load the feed.",
          );
      } finally {
        loading = false;
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [revision]);

  async function mutate(key: string, path: string, method = "POST", body = {}) {
    setPending(key);
    try {
      await api(path, { method, body: JSON.stringify(body) });
      setRevision((current) => current + 1);
      return true;
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : "Could not save changes.",
      );
      return false;
    } finally {
      setPending("");
    }
  }

  const repositories = feed?.repositories ?? [];
  const releases = feed?.releases ?? [];
  const currentRepo = repositories.find((repo) => repo.id === selectedRepo);
  const activeRepo = currentRepo?.id ?? null;
  const unread = releases.filter((release) => !release.reviewed).length;
  const today = releases.filter(
    (release) =>
      new Date(release.publishedAt).toDateString() ===
      new Date().toDateString(),
  ).length;
  const syncTimes = repositories
    .map((repo) => repo.syncedAt)
    .filter((time): time is string => Boolean(time))
    .sort();
  const lastSync = syncTimes.at(-1) ?? null;
  const failures = repositories.filter((repo) => repo.error);
  const filtered = releases
    .filter((release) => {
      const repo = repositories.find(
        (item) => item.id === release.repositoryId,
      );
      return (
        (!activeRepo || release.repositoryId === activeRepo) &&
        (filter === "all" || release.kind === filter) &&
        (!unreadOnly || !release.reviewed) &&
        `${repo?.fullName} ${release.title} ${release.tag} ${release.body}`
          .toLowerCase()
          .includes(query.toLowerCase())
      );
    })
    .sort((left, right) =>
      sort === "oldest"
        ? Date.parse(left.publishedAt) - Date.parse(right.publishedAt)
        : Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
    );

  function selectRepository(id: number | null) {
    setSelectedRepo(id);
    setVisible(20);
    setSidebarOpen(false);
  }

  return (
    <>
      {showScrollToTop && (
        <button
          type="button"
          className="scroll-to-top"
          aria-label="Scroll to top"
          title="Scroll to top"
          onClick={() =>
            window.scrollTo({
              top: 0,
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "instant"
                : "smooth",
            })
          }
        >
          <Icon name="arrow-up" size={22} />
        </button>
      )}
      <header className="topbar">
        <a className="brand" href="/" aria-label="ReleaseMonitor home">
          <span className="brand-icon">
            <Icon name="activity" size={22} />
          </span>
          <span>
            Release<span className="brand-period">.</span><span className="brand-light">Monitor</span>
          </span>
        </a>
        <div className="topbar-meta">
          <span className="status-dot" /> SHARED FEED{" "}
          <span className="topbar-divider" /> <Icon name="git" size={15} />
          <span>PUBLIC REPOSITORIES</span>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button theme-toggle"
            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            onClick={() =>
              setTheme((currentTheme) =>
                currentTheme === "light" ? "dark" : "light",
              )
            }
          >
            <Icon name={theme === "light" ? "moon" : "sun"} size={19} />
          </button>
          <button
            className="icon-button mobile-menu"
            title="Toggle repositories"
            aria-label="Toggle repositories"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Icon name="list" size={20} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
          <div className="sidebar-heading">
            <span className="eyebrow">WORKSPACE</span>
            <span className="mono muted">01</span>
          </div>
          <button
            className={`nav-item ${!activeRepo ? "active" : ""}`}
            onClick={() => selectRepository(null)}
          >
            <Icon name="layers" size={17} />
            <span>All releases</span>
            <span className="count">{releases.length}</span>
          </button>
          <div className="watchlist-title">
            <span className="eyebrow">WATCHLIST</span>
            <span className="mono muted">
              {String(repositories.length).padStart(2, "0")}
            </span>
          </div>
          <div className="repository-list">
            {repositories.map((repo) => (
              <div
                className={`repository-row ${activeRepo === repo.id ? "selected" : ""}`}
                key={repo.id}
              >
                <button
                  className="repository-select"
                  onClick={() => selectRepository(repo.id)}
                  title={`${providers[repo.provider].label}: ${repo.fullName}`}
                >
                  <img src={repo.avatarUrl} width="26" height="26" alt="" />
                  <Icon name={providers[repo.provider].icon} size={13} />
                  <span className="repository-name">
                    <strong>{repositoryName(repo.fullName).name}</strong>
                    <small>{repositoryName(repo.fullName).owner}</small>
                  </span>
                  {repo.error ? (
                    <Icon name="exclamation-circle" size={14} className="error-color" />
                  ) : (
                    <span className="repo-dot" />
                  )}
                </button>
                <button
                  className="icon-button remove-repo"
                  aria-label={`Remove ${repo.fullName}`}
                  title={`Remove ${repo.fullName}`}
                  disabled={Boolean(pending)}
                  onClick={async () => {
                    if (
                      window.confirm(
                        `Remove ${repo.fullName} and its cached releases from the shared feed?`,
                      )
                    )
                      await mutate(
                        `remove-${repo.id}`,
                        `/repositories/${repo.id}`,
                        "DELETE",
                      );
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            {!repositories.length && (
              <p className="sidebar-empty">No repositories yet</p>
            )}
          </div>
          <button className="sidebar-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add repository
          </button>
          <footer className="sidebar-bottom">
            <div>
              <span
                className={`status-dot ${failures.length ? "warning" : ""}`}
              />
              <span>
                {feed?.syncing
                  ? "Sync in progress"
                  : failures.length
                    ? "Sync needs attention"
                    : "Monitor online"}
              </span>
            </div>
            <span className="mono muted">
              POLL INTERVAL / {feed?.intervalMinutes ?? 60} MIN
            </span>
            <p className="sidebar-copyright">
              a <a
                href="https://www.toni-kolev.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                toni kolev
              </a> project
              &copy; {new Date().getFullYear()} {" "}
            </p>

            <p className="sidebar-copyright">
              <a
                href="https://github.com/toni-kolev/ReleaseMonitor"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span aria-hidden="true" className="app-icon bi bi-github"></span> GitHub
              </a>
            </p>
          </footer>
        </aside>

        <main>
          <section className="page-heading">
            <div>
              <div className="eyebrow section-label">
                <span className="blue-rule" /> REPOSITORY INTELLIGENCE
              </div>
              <h1>
                Releases<span className="heading-period">.</span>
              </h1>
              <p className="heading-subtitle">
                {currentRepo
                  ? currentRepo.fullName
                  : `${repositories.length} repositories / ${unread} releases awaiting review`}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                onClick={() => void mutate("review-all", "/review-all")}
                disabled={!unread || Boolean(pending)}
              >
                <Icon name="check-all" size={16} /> Mark all read
              </button>
              <button
                className="button primary"
                onClick={() => setAdding(true)}
              >
                <Icon name="plus" size={17} /> Add repository
              </button>
            </div>
          </section>

          <section className="stats" aria-label="Feed statistics">
            <div className="stat">
              <div className="stat-label">
                WATCHING
                <Icon name="signpost-split" size={15} />
              </div>
              <div className="stat-value">
                {String(repositories.length).padStart(2, "0")}
                <span>repositories</span>
              </div>
              <span className="stat-foot">GitHub, GitLab &amp; Codeberg</span>
            </div>
            <div className="stat">
              <div className="stat-label">
                PUBLISHED TODAY
                <Icon name="arrow-up-right" size={16} />
              </div>
              <div className="stat-value">
                {String(today).padStart(2, "0")}
                <span>releases</span>
              </div>
              <span className="stat-foot">Across your watchlist</span>
            </div>
            <div className="stat">
              <div className="stat-label">
                UNREVIEWED
                <Icon name="inbox" size={15} />
              </div>
              <div className="stat-value cobalt">
                {String(unread).padStart(2, "0")}
                <span>releases</span>
              </div>
              <span className="stat-foot">
                {unread ? "Awaiting review" : "All caught up"}
              </span>
            </div>
            <div className="stat">
              <div className="stat-label">
                LAST SYNC
                <Icon name="activity" size={15} />
              </div>
              <div className="sync-value">
                {feed?.syncing ? "Syncing" : lastSync ? ago(lastSync) : "--"}
                <button
                  className="icon-button"
                  aria-label="Sync releases"
                  title="Sync releases"
                  disabled={
                    Boolean(pending) || feed?.syncing || !repositories.length
                  }
                  onClick={() => void mutate("sync", "/sync")}
                >
                  <Icon
                    name="arrow-repeat"
                    size={16}
                    className={feed?.syncing ? "spin" : ""}
                  />
                </button>
              </div>
              <span
                className={`stat-foot ${failures.length ? "error-color" : "green"}`}
              >
                <span
                  className={`status-dot ${failures.length ? "warning" : ""}`}
                />
                {failures.length
                  ? `${failures.length} sync error${failures.length > 1 ? "s" : ""}`
                  : repositories.length
                    ? "Automatic polling enabled"
                    : "Ready to connect"}
              </span>
            </div>
          </section>

          {error && (
            <div className="notice error-notice" role="alert">
              <Icon name="exclamation-circle" size={17} />
              <span>{error}</span>
              <button
                className="icon-button"
                title="Retry"
                aria-label="Retry"
                onClick={() => setRevision((current) => current + 1)}
              >
                <Icon name="arrow-repeat" size={16} />
              </button>
            </div>
          )}
          {failures.map((repo) => (
            <div className="notice" key={repo.id} role="status">
              <Icon name="exclamation-circle" size={17} />
              <span>
                <strong>{repo.fullName}:</strong> {repo.error}
              </span>
            </div>
          ))}

          <section className="stream" aria-label="Release feed">
            <div className="stream-heading">
              <div className="stream-title">
                <h2>
                  {currentRepo
                    ? repositoryName(currentRepo.fullName).name
                    : "Release feed"}
                </h2>
                <span className="feed-total mono">{filtered.length}</span>
              </div>
              <label className="feed-search">
                <Icon name="search" size={16} />
                <input
                  aria-label="Filter releases"
                  placeholder="Filter releases..."
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setVisible(20);
                  }}
                />
                {query && (
                  <button
                    className="icon-button"
                    aria-label="Clear filter"
                    title="Clear filter"
                    onClick={() => setQuery("")}
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
              </label>
            </div>
            <div className="filter-row">
              <div className="segments" aria-label="Release type">
                {filters.map((item) => (
                  <button
                    aria-pressed={filter === item}
                    className={filter === item ? "active" : ""}
                    key={item}
                    onClick={() => {
                      setFilter(item);
                      setVisible(20);
                    }}
                  >
                    {item === "all" ? "All releases" : item}
                  </button>
                ))}
              </div>
              <label className="unread-toggle">
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(event) => {
                    setUnreadOnly(event.target.checked);
                    setVisible(20);
                  }}
                />
                Unread only
              </label>
            </div>
            <div className="stream-meta">
              <div className="repository-filter">
                <span className="eyebrow">
                  {activeRepo ? currentRepo?.fullName : "ALL REPOSITORIES"}
                </span>
                {activeRepo && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Clear repository filter"
                    title="Clear repository filter"
                    onClick={() => selectRepository(null)}
                  >
                    <Icon name="x-circle" size={16} />
                  </button>
                )}
              </div>
              <label className="sort-label">
                <Icon name="arrow-down" size={12} />
                <select
                  aria-label="Sort releases"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </label>
            </div>

            {!feed && !error ? (
              <div className="empty-state">
                <Icon name="arrow-clockwise" className="spin" size={28} />
                <h2>Loading releases</h2>
              </div>
            ) : !repositories.length ? (
              <div className="empty-state initial-empty">
                <div className="empty-symbol">
                  <Icon name="signpost-split" size={32} />
                </div>
                <span className="eyebrow">WATCHLIST / EMPTY</span>
                <h2>Your next release starts here.</h2>
                <button
                  className="button primary"
                  onClick={() => setAdding(true)}
                >
                  <Icon name="plus" size={17} /> Add repository
                </button>
              </div>
            ) : !filtered.length ? (
              <div className="empty-state">
                <Icon name="inbox" size={30} />
                <h2>
                  {releases.length
                    ? "No matching releases"
                    : "No published releases yet"}
                </h2>
                {(query || filter !== "all" || unreadOnly || activeRepo) && (
                  <button
                    className="button secondary"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                      setUnreadOnly(false);
                      setSelectedRepo(null);
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div className="release-list">
                {filtered.slice(0, visible).map((release) => (
                  <ReleaseCard
                    key={release.id}
                    release={release}
                    repository={
                      repositories.find(
                        (repo) => repo.id === release.repositoryId,
                      )!
                    }
                    disabled={Boolean(pending)}
                    onReview={() =>
                      void mutate(
                        `review-${release.id}`,
                        `/releases/${release.id}`,
                        "PATCH",
                        { reviewed: !release.reviewed },
                      )
                    }
                  />
                ))}
              </div>
            )}
            {visible < filtered.length && (
              <button
                className="load-more"
                onClick={() => setVisible((current) => current + 20)}
              >
                <Icon name="chevron-down" size={16} /> Load more releases{" "}
                <span className="mono">({filtered.length - visible})</span>
              </button>
            )}
          </section>
          <footer className="page-footer">
            <span>
              RELEASEMONITOR <span className="muted">/</span> SHARED WORKSPACE
            </span>
            <span>
              <span className="status-dot" /> GITHUB, GITLAB &amp; CODEBERG
            </span>
          </footer>
        </main>
      </div>
      {adding && (
        <AddRepository
          repositories={repositories}
          onClose={() => setAdding(false)}
          onAdded={() => setRevision((current) => current + 1)}
        />
      )}
    </>
  );
}

function ReleaseCard({
  release,
  repository,
  disabled,
  onReview,
}: {
  release: Release;
  repository: Repository;
  disabled: boolean;
  onReview: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const source = providers[repository.provider];
  async function copy() {
    try {
      await navigator.clipboard.writeText(release.url);
      setCopyStatus("Link copied");
    } catch {
      setCopyStatus("Could not copy link");
    }
  }
  return (
    <article className={`release-card release-${release.kind} ${release.reviewed ? "reviewed" : ""}`}>
      <div className="release-top">
        <div className="release-repository">
          <img src={repository.avatarUrl} alt="" width="24" height="24" />
          <span title={source.label}><Icon name={source.icon} size={14} /></span>
          <a href={repository.url} target="_blank" rel="noreferrer">
            {repository.fullName}
          </a>
          <span className="stars">
            <Icon name="star" size={12} />
            {number.format(repository.stars)}
          </span>
        </div>
        <time
          dateTime={release.publishedAt}
          title={new Date(release.publishedAt).toLocaleString()}
        >
          {ago(release.publishedAt)}
          {!release.reviewed && <span className="unread-dot" title="Unread" />}
        </time>
      </div>
      <div className="release-body">
        <div className="version-line">
          <span className={`kind ${release.kind}`}>{release.kind}</span>
          <span className="tag">
            <Icon name="tag" size={13} />
            {release.tag}
          </span>
        </div>
        <h3>{release.title}</h3>
        <div className={`release-notes ${expanded ? "expanded" : "collapsed"}`}>
          {release.body ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                a: ({ children, href }) => (
                  <a
                    href={
                      href?.startsWith("/") ? `${new URL(repository.url).origin}${href}` : href
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {children}
                  </a>
                ),
                img: ({ alt, src }) => (
                  <a href={src} target="_blank" rel="noreferrer">
                    {alt || "View image"}
                  </a>
                ),
              }}
            >
              {release.body}
            </ReactMarkdown>
          ) : (
            <p className="muted">No release notes provided.</p>
          )}
        </div>
        {expanded && release.assets.length > 0 && (
          <div className="assets">
            <span className="eyebrow">
              RELEASE ASSETS / {release.assets.length}
            </span>
            {release.assets.map((asset) => (
              <a
                key={asset.url}
                href={asset.url}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="download" size={15} />
                <span>{asset.name}</span>
                <small className="mono muted">
                  {number.format(asset.size / 1024)} KB
                </small>
                <Icon name="arrow-up-right" size={14} />
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="release-footer">
        <div className="release-actions">
          <button
            className="notes-button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            {expanded ? "Collapse notes" : "Release notes"}
            <Icon name="chevron-down" size={14} className={expanded ? "rotated" : ""} />
          </button>
          <a
            className="source-link"
            href={release.url}
            target="_blank"
            rel="noreferrer"
          >
            {source.label}
            <Icon name={source.icon} size={14} />
          </a>
          <button
            className="icon-button"
            title="Copy release link"
            aria-label={`Copy link for ${release.tag}`}
            onClick={() => void copy()}
          >
            <Icon name="copy" size={14} />
          </button>
          {copyStatus && (
            <span className="copy-status" role="status">
              {copyStatus}
            </span>
          )}
        </div>
        <button
          className={`review-button ${release.reviewed ? "is-reviewed" : ""}`}
          onClick={onReview}
          disabled={disabled}
          title={
            release.reviewed
              ? "Mark unread for everyone"
              : "Mark read for everyone"
          }
        >
          <Icon name="check" size={15} />
          {release.reviewed ? "Reviewed" : "Mark read"}
        </button>
      </div>
    </article>
  );
}

function AddRepository({
  repositories,
  onClose,
  onAdded,
}: {
  repositories: Repository[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [provider, setProvider] = useState<Provider>("github");
  const source = providers[provider];
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (query.trim().length < 2) return;
    const timeout = window.setTimeout(async () => {
      try {
        const result = await api<{ repositories: Repository[] }>(
          `/search?q=${encodeURIComponent(query.trim())}&provider=${provider}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setResults(result.repositories);
          setSearched(true);
        }
      } catch (problem) {
        if (!controller.signal.aborted)
          setError(
            problem instanceof Error ? problem.message : "Search failed.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 500);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, provider]);

  async function add(repo: Repository) {
    setPending(repo.id);
    setError("");
    try {
      await api("/repositories", {
        method: "POST",
        body: JSON.stringify({ fullName: repo.fullName, provider: repo.provider }),
      });
      setAdded((current) => [...current, `${repo.provider}:${repo.fullName.toLowerCase()}`]);
      onAdded();
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Could not add repository.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      aria-labelledby="add-title"
    >
      <div className="dialog-content">
        <div className="dialog-heading">
          <div>
            <span className="eyebrow cobalt">WATCHLIST / ADD</span>
            <h2 id="add-title">Add repository</h2>
          </div>
          <button
            className="icon-button"
            title="Close"
            aria-label="Close search"
            onClick={onClose}
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="segments provider-selector" aria-label="Repository provider">
          {(Object.keys(providers) as Provider[]).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={provider === item}
              className={provider === item ? "active" : ""}
              disabled={pending !== null}
              onClick={() => {
                if (provider === item) return;
                setProvider(item);
                setResults([]);
                setError("");
                setSearched(false);
                setLoading(query.trim().length >= 2);
              }}
            >
              <Icon name={providers[item].icon} size={16} />
              {providers[item].label}
            </button>
          ))}
        </div>
        <label className="github-search">
          <Icon name="search" size={20} />
          <input
            autoFocus
            aria-label={`Search public ${source.label} repositories`}
            maxLength={120}
            placeholder={`Search ${source.label} repositories...`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setResults([]);
              setError("");
              setSearched(false);
              setLoading(event.target.value.trim().length >= 2);
            }}
          />
          {loading && <Icon name="arrow-clockwise" className="spin" size={18} />}
        </label>
        {error && (
          <div className="notice error-notice" role="alert">
            <Icon name="exclamation-circle" size={16} />
            <span>{error}</span>
          </div>
        )}
        <div className="search-results" aria-live="polite" aria-busy={loading}>
          {query.trim().length < 2 ? (
            <div className="search-empty">
              <Icon name={source.icon} size={32} />
              <span>Public repositories</span>
            </div>
          ) : loading ? (
            <div className="search-empty">
              <Icon name="arrow-clockwise" className="spin" size={25} />
              <span>Searching {source.label}...</span>
            </div>
          ) : searched && !results.length ? (
            <div className="search-empty">
              <Icon name="search" size={25} />
              <span>No repositories found</span>
            </div>
          ) : (
            results.map((repo) => {
              const watched =
                added.includes(`${repo.provider}:${repo.fullName.toLowerCase()}`) ||
                repositories.some((item) => item.provider === repo.provider && item.fullName.toLowerCase() === repo.fullName.toLowerCase());
              return (
                <div className="search-result" key={repo.id}>
                  <img src={repo.avatarUrl} alt="" width="36" height="36" />
                  <div className="search-result-info">
                    <a href={repo.url} target="_blank" rel="noreferrer">
                      {repo.fullName}
                      <Icon name="box-arrow-up-right" size={12} />
                    </a>
                    <p>{repo.description || "No description provided."}</p>
                    <div className="result-meta">
                      <span>
                        <Icon name="star" size={12} />
                        {number.format(repo.stars)}
                      </span>
                      {repo.language && <span>{repo.language}</span>}
                    </div>
                  </div>
                  <button
                    className={`icon-button result-add ${watched ? "green" : ""}`}
                    aria-label={
                      watched
                        ? `${repo.fullName} added`
                        : `Add ${repo.fullName}`
                    }
                    title={watched ? "Already watching" : "Add repository"}
                    disabled={watched || pending !== null}
                    onClick={() => void add(repo)}
                  >
                    {pending === repo.id ? (
                      <Icon name="arrow-clockwise" size={18} className="spin" />
                    ) : watched ? (
                      <Icon name="check" size={18} />
                    ) : (
                      <Icon name="plus" size={18} />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="dialog-footer">
          <Icon name={source.icon} size={14} />
          <span>{source.label.toUpperCase()} PUBLIC API</span>
          <button className="text-button" onClick={onClose}>
            Done
            <Icon name="arrow-right" size={14} />
          </button>
        </div>
      </div>
    </dialog>
  );
}
