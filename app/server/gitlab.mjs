import { ApiError, repositoryData, releaseData } from "./github.mjs";

const origin = "https://gitlab.com";

// GitLab avatars are sometimes site-relative (/uploads/...), unlike GitHub.
function avatarUrl(project) {
  const url = project.avatar_url || project.namespace?.avatar_url || "";
  if (!url) return "";
  return url.startsWith("http") ? url : `${origin}${url}`;
}

function repository(project) {
  return {
    ...repositoryData({
      id: project.id,
      full_name: project.path_with_namespace,
      description: project.description ?? "",
      owner: { avatar_url: avatarUrl(project) },
      html_url: project.web_url,
      stargazers_count: project.star_count,
      language: null,
    }),
    provider: "gitlab",
  };
}

// GitLab releases have no numeric ID; tag names are the stable upstream key.
function gitlabRelease(release, repo) {
  return releaseData({
    id: release.tag_name,
    tag_name: release.tag_name,
    name: release.name,
    body: release.description ?? "",
    html_url: `${repo.url}/-/releases/${encodeURIComponent(release.tag_name)}`,
    published_at: release.released_at || release.created_at,
    author: { login: release.author?.username ?? "unknown" },
    assets: (release.assets?.links ?? []).map((link) => ({
      name: link.name,
      browser_download_url: link.direct_asset_url || link.url,
      size: link.size ?? 0,
    })),
  });
}

export function createGitlab({ token = "", fetcher = fetch } = {}) {
  let blockedUntil = 0;
  async function request(path, etag) {
    if (Date.now() < blockedUntil)
      throw new ApiError(
        `GitLab rate limit reached. Retry after ${new Date(blockedUntil).toISOString()}.`,
        429,
      );
    const headers = { Accept: "application/json", "User-Agent": "ReleaseMonitor" };
    if (token) headers["PRIVATE-TOKEN"] = token;
    if (etag) headers["If-None-Match"] = etag;
    let response;
    try {
      response = await fetcher(`${origin}/api/v4${path}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ApiError("GitLab could not be reached. Cached releases are still available.");
    }
    if (response.status === 304) return { unchanged: true, etag };
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")))
    ) {
      blockedUntil = Math.max(
        Date.now() + 60000,
        Number(response.headers.get("ratelimit-reset")) * 1000 || 0,
        Date.now() + Number(response.headers.get("retry-after") || 60) * 1000,
      );
      throw new ApiError(
        `GitLab rate limit reached. Retry after ${new Date(blockedUntil).toISOString()}.`,
        429,
      );
    }
    if (!response.ok)
      throw new ApiError(
        response.status === 404
          ? "Public repository not found."
          : response.status === 401
            ? "The configured GitLab token is invalid."
            : `GitLab returned HTTP ${response.status}.`,
        response.status === 404 ? 404 : 502,
      );
    return { data: await response.json(), etag: response.headers.get("etag") };
  }
  return {
    search: async (query) => {
      const { data } = await request(
        `/projects?search=${encodeURIComponent(query)}&visibility=public&order_by=star_count&sort=desc&simple=true&per_page=20`,
      );
      return data.filter((project) => !project.visibility || project.visibility === "public").map(repository);
    },
    repository: async (fullName) => {
      const { data } = await request(`/projects/${encodeURIComponent(fullName)}`);
      if (data.visibility && data.visibility !== "public")
        throw new ApiError("Only public repositories can be added.", 400);
      return repository(data);
    },
    releases: async (repo) => {
      const result = await request(
        `/projects/${encodeURIComponent(repo.fullName)}/releases?per_page=100`,
        repo.etag,
      );
      return {
        etag: result.etag ?? null,
        releases: result.unchanged
          ? []
          : result.data
              .filter(
                (release) =>
                  !release.upcoming_release && (release.released_at || release.created_at),
              )
              .map((release) => gitlabRelease(release, repo)),
      };
    },
  };
}
