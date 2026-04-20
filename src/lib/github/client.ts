/// Thin GitHub REST client used by the OAuth connect flow and repo picker.
///
/// We deliberately avoid Octokit for now: the surface area we need is small
/// (user info, list repos, get repo, exchange code) and adding the full SDK
/// pulls in a non-trivial dependency. If we grow beyond ~5 endpoints or need
/// webhooks / pagination helpers, switch to Octokit.

import { GITHUB_TOKEN_URL } from "./oauth-config";

const GITHUB_API_BASE = "https://api.github.com";
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
