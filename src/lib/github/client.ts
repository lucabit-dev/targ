/// Thin GitHub REST client used by the OAuth connect flow and repo picker.
///
/// We deliberately avoid Octokit for now: the surface area we need is small
/// (user info, list repos, get repo, exchange code) and adding the full SDK
/// pulls in a non-trivial dependency. If we grow beyond ~5 endpoints or need
/// webhooks / pagination helpers, switch to Octokit.

import { GITHUB_TOKEN_URL } from "./oauth-config";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_GRAPHQL_URL = `${GITHUB_API_BASE}/graphql`;
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_ACCEPT = "application/vnd.github+json";

export class GithubApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
    this.body = body;
  }
}

async function githubFetch(
  path: string,
  init: RequestInit & { token?: string } = {}
) {
  const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Accept", DEFAULT_ACCEPT);
  headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
  headers.set("User-Agent", "targ-app");

  if (init.token) {
    headers.set("Authorization", `Bearer ${init.token}`);
  }

  const response = await fetch(url, { ...init, headers });

  if (!response.ok) {
    let body: unknown = undefined;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => undefined);
    }
    const message =
      (body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : undefined) ?? `GitHub API ${response.status}`;
    throw new GithubApiError(response.status, message, body);
  }

  return response;
}

export type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
};

export async function getAuthenticatedUser(token: string): Promise<GithubUser> {
  const response = await githubFetch("/user", { token });
  const json = (await response.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
  };
  return {
    id: json.id,
    login: json.login,
    name: json.name ?? null,
    avatar_url: json.avatar_url ?? null,
  };
}

export type GithubRepo = {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  visibility: "public" | "private" | "internal" | "unknown";
  description: string | null;
  htmlUrl: string;
  cloneUrl: string;
  pushedAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  permissions: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
};

type GithubRepoApi = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  visibility?: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  pushed_at: string | null;
  updated_at: string | null;
  archived: boolean;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
};

function normalizeRepo(raw: GithubRepoApi): GithubRepo {
  const visibility =
    raw.visibility === "public" ||
    raw.visibility === "private" ||
    raw.visibility === "internal"
      ? raw.visibility
      : raw.private
        ? "private"
        : "public";

  return {
    id: raw.id,
    fullName: raw.full_name,
    owner: raw.owner.login,
    name: raw.name,
    defaultBranch: raw.default_branch,
    visibility,
    description: raw.description,
    htmlUrl: raw.html_url,
    cloneUrl: raw.clone_url,
    pushedAt: raw.pushed_at,
    updatedAt: raw.updated_at,
    archived: raw.archived,
    permissions: {
      admin: raw.permissions?.admin ?? false,
      push: raw.permissions?.push ?? false,
      pull: raw.permissions?.pull ?? false,
    },
  };
}

export type ListUserReposOptions = {
  perPage?: number;
  page?: number;
  /// Controls the `affiliation` filter on GitHub's list-repos endpoint:
  /// - "owner" = repos you directly own
  /// - "collaborator" = repos you were invited to
  /// - "organization_member" = repos in orgs you belong to
  /// Default is all three.
  affiliation?: ReadonlyArray<
    "owner" | "collaborator" | "organization_member"
  >;
  sort?: "created" | "updated" | "pushed" | "full_name";
  direction?: "asc" | "desc";
};

export async function listUserRepos(
  token: string,
  options: ListUserReposOptions = {}
): Promise<GithubRepo[]> {
  const params = new URLSearchParams();
  params.set("per_page", String(Math.min(options.perPage ?? 50, 100)));
  params.set("page", String(options.page ?? 1));
  params.set(
    "affiliation",
    (options.affiliation ?? ["owner", "collaborator", "organization_member"]).join(",")
  );
  params.set("sort", options.sort ?? "updated");
  params.set("direction", options.direction ?? "desc");

  const response = await githubFetch(`/user/repos?${params.toString()}`, {
    token,
  });
  const raw = (await response.json()) as GithubRepoApi[];
  return raw.map(normalizeRepo);
}

export async function getRepo(
  token: string,
  owner: string,
  name: string
): Promise<GithubRepo> {
  const response = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { token }
  );
  return normalizeRepo((await response.json()) as GithubRepoApi);
}

/// Resolves a branch (or any ref) to a full commit SHA. Used as the first step
/// of a sync: pin the tree read to a specific commit so the resulting snapshot
/// is reproducible even if the branch advances mid-sync.
export async function getCommitSha(
  token: string,
  owner: string,
  name: string,
  ref: string
): Promise<string> {
  const response = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}`,
    { token }
  );
  const payload = (await response.json()) as { sha: string };
  return payload.sha;
}

export type GithubTreeEntry = {
  path: string;
  mode: string;
  /// "blob" = file, "tree" = directory, "commit" = submodule. We only persist blobs.
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

export type GithubTreeResult = {
  sha: string;
  truncated: boolean;
  entries: GithubTreeEntry[];
};

/// Fetches raw blob content by SHA. GitHub's blob API returns a base64 or
/// UTF-8 payload depending on encoding; we always decode to a UTF-8 string
/// and treat binary content as an empty string (callers should pre-filter
/// blobs by file kind).
export async function getBlobContent(
  token: string,
  owner: string,
  name: string,
  blobSha: string
): Promise<string> {
  const response = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs/${encodeURIComponent(blobSha)}`,
    { token }
  );
  const payload = (await response.json()) as {
    content: string;
    encoding: string;
  };
  if (payload.encoding === "base64") {
    const buf = Buffer.from(payload.content, "base64");
    return buf.toString("utf8");
  }
  return payload.content ?? "";
}

/// Recursive tree read for a commit. GitHub returns up to ~100k entries in a
/// single call; anything beyond that sets `truncated: true` and the caller
/// must treat the snapshot as PARTIAL.
export async function getTreeRecursive(
  token: string,
  owner: string,
  name: string,
  commitSha: string
): Promise<GithubTreeResult> {
  const response = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    { token }
  );
  const payload = (await response.json()) as {
    sha: string;
    truncated: boolean;
    tree: Array<{
      path: string;
      mode: string;
      type: string;
      sha: string;
      size?: number;
    }>;
  };

  const entries: GithubTreeEntry[] = payload.tree
    .filter(
      (entry): entry is GithubTreeEntry =>
        entry.type === "blob" || entry.type === "tree" || entry.type === "commit"
    )
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      type: entry.type,
      sha: entry.sha,
      size: entry.size,
    }));

  return {
    sha: payload.sha,
    truncated: Boolean(payload.truncated),
    entries,
  };
}

/// Commit summary returned by GitHub's list-commits endpoint. We only keep
/// the fields relevant to handoff-packet blame enrichment (Phase 2.5). The
/// raw API includes much more (parents, tree, verification, stats) that we
/// deliberately discard so callers can't accidentally leak heavy payloads
/// into the packet.
export type GithubCommitSummary = {
  sha: string;
  message: string;
  /// Prefer the GitHub login when present (so we can `@mention`); fall back
  /// to the commit author name (the raw git identity).
  authorLogin: string | null;
  authorName: string;
  authorEmail: string | null;
  /// ISO-8601 UTC date string (the *author* date — when the work was made,
  /// not when it landed on the default branch).
  date: string;
  htmlUrl: string;
};

type GithubCommitApi = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: {
      name?: string | null;
      email?: string | null;
      date?: string | null;
    } | null;
  };
  author: {
    login?: string | null;
  } | null;
};

function normalizeCommit(raw: GithubCommitApi): GithubCommitSummary {
  const authorLogin = raw.author?.login ?? null;
  const authorName = raw.commit.author?.name ?? authorLogin ?? "unknown";
  const date =
    raw.commit.author?.date ?? new Date(0).toISOString();
  return {
    sha: raw.sha,
    message: raw.commit.message,
    authorLogin,
    authorName,
    authorEmail: raw.commit.author?.email ?? null,
    date,
    htmlUrl: raw.html_url,
  };
}

export type ListCommitsForPathOptions = {
  /// Branch or commit SHA to read from. Defaults to the repo's default
  /// branch if omitted.
  ref?: string;
  /// Hard cap on the returned slice. GitHub's per_page max is 100. Keep
  /// this small for blame enrichment — we only need the most recent few.
  perPage?: number;
  /// Earliest author date to include (ISO 8601). Used to scope "suspected
  /// regressions" to the last N days without pulling the whole history.
  since?: string;
};

/// Lists the most recent commits that touched `path`, newest first. This is
/// the canonical GitHub equivalent of `git log -- <path>`. We use it at
/// packet-build time to enrich `RepoLocation.blame` (last commit touching
/// the file) and `repoContext.suspectedRegressions` (commits touching
/// resolved files in the last N days).
export async function listCommitsForPath(
  token: string,
  owner: string,
  name: string,
  path: string,
  options: ListCommitsForPathOptions = {}
): Promise<GithubCommitSummary[]> {
  const params = new URLSearchParams();
  params.set("path", path);
  params.set("per_page", String(Math.min(Math.max(options.perPage ?? 5, 1), 100)));
  if (options.ref) params.set("sha", options.ref);
  if (options.since) params.set("since", options.since);

  const response = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?${params.toString()}`,
    { token }
  );
  const raw = (await response.json()) as GithubCommitApi[];
  return raw.map(normalizeCommit);
}

// ---------------------------------------------------------------------------
// GraphQL — line-level blame (Phase 2.6)
// ---------------------------------------------------------------------------

/// One contiguous range of lines in a file that all share the same most-recent
/// commit. The GraphQL `blame` query returns the file partitioned into these
/// ranges, sorted by line. Callers locate a specific line by finding the range
/// where `startingLine <= line <= endingLine`.
export type GithubBlameRange = {
  startingLine: number;
  endingLine: number;
  commit: GithubCommitSummary;
};

export type GithubBlameResult = {
  ranges: GithubBlameRange[];
  /// Most-recent commit across all ranges. Surface for callers that have a
  /// `RepoLocation` without a `line` (path-only) so they can still attach a
  /// "last touched" attribution at the file granularity. `null` when the
  /// blame returned no ranges (empty file, file missing at the ref, etc.).
  mostRecentCommit: GithubCommitSummary | null;
};

type GraphqlBlameResponse = {
  data?: {
    repository: {
      object: {
        blame: {
          ranges: Array<{
            startingLine: number;
            endingLine: number;
            commit: {
              oid: string;
              messageHeadline: string;
              committedDate: string;
              url: string;
              author: {
                user: { login: string } | null;
                name: string | null;
                email: string | null;
              } | null;
              associatedPullRequests: {
                nodes: Array<{ number: number }>;
              };
            };
          }>;
        } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message: string; type?: string; path?: unknown }>;
};

const BLAME_GRAPHQL_QUERY = /* GraphQL */ `
  query Blame($owner: String!, $name: String!, $oid: GitObjectID!, $path: String!) {
    repository(owner: $owner, name: $name) {
      object(oid: $oid) {
        ... on Commit {
          blame(path: $path) {
            ranges {
              startingLine
              endingLine
              commit {
                oid
                messageHeadline
                committedDate
                url
                author {
                  user { login }
                  name
                  email
                }
                associatedPullRequests(first: 1) {
                  nodes { number }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/// Fetches per-line blame for a file at a given commit SHA. Uses the GraphQL
/// API because REST has no native blame endpoint. The whole file's blame
/// comes back in one round-trip — for our use case (handoff packets with
/// 1-3 lines per file of interest) one query per file is the right
/// granularity, since multiple `(file, line)` lookups against the same
/// file should reuse the same response.
///
/// Returns `{ ranges: [], mostRecentCommit: null }` when:
///   - the file doesn't exist at that commit (renamed, deleted),
///   - the ref points at a tree object that isn't a commit,
///   - the GraphQL response shape is null in any expected layer.
///
/// Throws `GithubApiError` on transport-level failures (auth, 5xx,
/// network) so the caller can decide whether to fall back or surface.
export async function getFileBlameRanges(
  token: string,
  owner: string,
  name: string,
  ref: string,
  path: string
): Promise<GithubBlameResult> {
  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: DEFAULT_ACCEPT,
      "Content-Type": "application/json",
      "User-Agent": "targ-app",
    },
    body: JSON.stringify({
      query: BLAME_GRAPHQL_QUERY,
      variables: { owner, name, oid: ref, path },
    }),
  });

  if (!response.ok) {
    let body: unknown = undefined;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => undefined);
    }
    throw new GithubApiError(
      response.status,
      `GitHub GraphQL ${response.status}`,
      body
    );
  }

  const payload = (await response.json()) as GraphqlBlameResponse;

  // GraphQL puts logical errors in `errors[]` even on a 200. Surface those
  // as `GithubApiError` so callers can apply the same fallback policy as
  // for REST errors.
  if (payload.errors && payload.errors.length > 0) {
    throw new GithubApiError(
      200,
      payload.errors[0].message,
      payload.errors
    );
  }

  const rawRanges = payload.data?.repository?.object?.blame?.ranges;
  if (!rawRanges || rawRanges.length === 0) {
    return { ranges: [], mostRecentCommit: null };
  }

  const ranges: GithubBlameRange[] = rawRanges.map((range) => {
    const c = range.commit;
    const login = c.author?.user?.login ?? null;
    const name = c.author?.name ?? login ?? "unknown";
    const pr = c.associatedPullRequests.nodes[0]?.number;
    // Encode the PR number into the message text so downstream consumers
    // that only have the message string (e.g. extractPrNumber) recover it
    // — REST commit payloads naturally have `(#N)` in squash-merge
    // messages, so we mirror that convention here for GraphQL commits.
    const messageWithPr = pr
      ? `${c.messageHeadline} (#${pr})`
      : c.messageHeadline;
    return {
      startingLine: range.startingLine,
      endingLine: range.endingLine,
      commit: {
        sha: c.oid,
        message: messageWithPr,
        authorLogin: login,
        authorName: name,
        authorEmail: c.author?.email ?? null,
        date: c.committedDate,
        htmlUrl: c.url,
      },
    };
  });

  const mostRecentCommit = ranges.reduce<GithubCommitSummary | null>(
    (acc, range) => {
      const ts = Date.parse(range.commit.date);
      if (!Number.isFinite(ts)) return acc;
      if (!acc) return range.commit;
      const accTs = Date.parse(acc.date);
      return ts > accTs ? range.commit : acc;
    },
    null
  );

  return { ranges, mostRecentCommit };
}

export type GithubOAuthTokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string;
  tokenType: string;
};

export async function exchangeCodeForToken(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GithubOAuthTokenResponse> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "targ-app",
    },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }).toString(),
  });

  if (!response.ok) {
    throw new GithubApiError(
      response.status,
      `GitHub token exchange failed (${response.status})`,
      await response.text().catch(() => undefined)
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (payload.error || !payload.access_token) {
    throw new GithubApiError(
      400,
      payload.error_description ??
        payload.error ??
        "GitHub did not return an access token.",
      payload
    );
  }

  const expiresAt =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? new Date(Date.now() + payload.expires_in * 1000)
      : null;

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt,
    scope: payload.scope ?? "",
    tokenType: payload.token_type ?? "bearer",
  };
}
