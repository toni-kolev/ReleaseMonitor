import semver from "semver";

export class ApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function repositoryData(repo) {
  return {
    id: repo.id,
    provider: "github",
    fullName: repo.full_name,
    description: repo.description ?? "",
    avatarUrl: repo.owner.avatar_url,
    url: repo.html_url,
    stars: repo.stargazers_count,
    language: repo.language,
  };
}

export function releaseData(release) {
  const version = semver.valid(release.tag_name);
  const parsed = version ? semver.parse(version) : null;
  const kind =
    release.prerelease || parsed?.prerelease.length
      ? "pre-release"
      : !parsed
        ? "other"
        : parsed.patch > 0
          ? "patch"
          : parsed.minor > 0
            ? "minor"
            : "major";
  return {
    id: release.id,
    tag: release.tag_name,
    title: release.name || release.tag_name,
    body: release.body ?? "",
    url: release.html_url,
    publishedAt: release.published_at,
    author: release.author?.login ?? "unknown",
    kind,
    assets: (release.assets ?? []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
    })),
  };
}

export function createGithub({ token = "", fetcher = fetch } = {}) {
  let blockedUntil = 0;
  async function request(path, etag) {
    if (Date.now() < blockedUntil)
      throw new ApiError(
        `GitHub rate limit reached. Retry after ${new Date(blockedUntil).toISOString()}.`,
        429,
      );
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ReleaseMonitor",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (etag) headers["If-None-Match"] = etag;
    let response;
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ApiError(
        "GitHub could not be reached. Cached releases are still available.",
      );
    }
    if (response.status === 304) return { unchanged: true, etag };
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")))
    ) {
      blockedUntil = Math.max(
        Date.now() + 60000,
        Number(response.headers.get("x-ratelimit-reset")) * 1000 || 0,
        Date.now() + Number(response.headers.get("retry-after") || 60) * 1000,
      );
      throw new ApiError(
        `GitHub rate limit reached. Retry after ${new Date(blockedUntil).toISOString()}.`,
        429,
      );
    }
    if (!response.ok)
      throw new ApiError(
        response.status === 404
          ? "Public repository not found."
          : response.status === 401
            ? "The configured GitHub token is invalid."
            : `GitHub returned HTTP ${response.status}.`,
        response.status === 404 ? 404 : 502,
      );
    return { data: await response.json(), etag: response.headers.get("etag") };
  }
  return {
    search: async (query) => {
      const result = await request(
        `/search/repositories?q=${encodeURIComponent(`${query} is:public`)}&per_page=20`,
      );
      return result.data.items
        .filter((repo) => !repo.private)
        .map(repositoryData);
    },
    repository: async (fullName) => {
      const { data } = await request(`/repos/${fullName}`);
      if (data.private)
        throw new ApiError("Only public repositories can be added.", 400);
      return repositoryData(data);
    },
    releases: async (repo) => {
      const result = await request(
        `/repos/${repo.fullName}/releases?per_page=100`,
        repo.etag,
      );
      return {
        etag: result.etag,
        releases: result.unchanged
          ? []
          : result.data
              .filter((release) => !release.draft && release.published_at)
              .map(releaseData),
      };
    },
  };
}
