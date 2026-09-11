import { ApiError, repositoryData, releaseData } from "./github.mjs";

export function createCodeberg({ token = "", fetcher = fetch } = {}) {
  let blockedUntil = 0;
  async function request(path) {
    if (Date.now() < blockedUntil)
      throw new ApiError("Codeberg rate limit reached. Retry later.", 429);
    const headers = { Accept: "application/json", "User-Agent": "ReleaseMonitor" };
    if (token) headers.Authorization = `token ${token}`;
    let response;
    try {
      response = await fetcher(`https://codeberg.org/api/v1${path}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ApiError("Codeberg could not be reached. Cached releases are still available.");
    }
    if (response.status === 429 || (response.status === 403 && response.headers.has("retry-after"))) {
      const retry = response.headers.get("retry-after");
      blockedUntil = Math.max(Date.now() + 60000,
        Number.isFinite(Number(retry)) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) || 0);
      throw new ApiError("Codeberg rate limit reached. Retry later.", 429);
    }
    if (!response.ok)
      throw new ApiError(
        response.status === 404 ? "Public repository not found."
          : response.status === 401 ? "The configured Codeberg token is invalid."
            : `Codeberg returned HTTP ${response.status}.`,
        response.status === 404 ? 404 : 502,
      );
    return { data: await response.json() };
  }
  function repository(repo) {
    return {
      ...repositoryData({ ...repo, stargazers_count: repo.stars_count }),
      provider: "codeberg",
    };
  }
  return {
    search: async (query) => {
      const { data } = await request(`/repos/search?q=${encodeURIComponent(query)}&limit=20`);
      return data.data.filter((repo) => !repo.private).map(repository);
    },
    repository: async (fullName) => {
      const { data } = await request(`/repos/${fullName}`);
      if (data.private) throw new ApiError("Only public repositories can be added.", 400);
      return repository(data);
    },
    releases: async (repo) => {
      const releases = [];
      for (let page = 1; releases.length < 100; page++) {
        const { data } = await request(`/repos/${repo.fullName}/releases?limit=50&page=${page}`);
        releases.push(...data);
        if (data.length < 50) break;
      }
      return {
        etag: null,
        releases: releases.slice(0, 100)
          .filter((release) => !release.draft && release.published_at)
          .map(releaseData),
      };
    },
  };
}