import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exchangeCodeForToken,
  getAuthenticatedUser,
  getFileBlameRanges,
  getRepo,
  GithubApiError,
  listCommitsForPath,
  listUserRepos,
} from "./client";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("github client", () => {
  describe("getAuthenticatedUser", () => {
    it("projects the user payload and includes auth headers", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: 42,
          login: "octo",
          name: "Octo Cat",
          avatar_url: "https://example.com/a.png",
        })
      );

      const user = await getAuthenticatedUser("ghu_token");

      expect(user).toEqual({
        id: 42,
        login: "octo",
        name: "Octo Cat",
        avatar_url: "https://example.com/a.png",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer ghu_token");
      expect(headers.get("Accept")).toContain("github");
      expect(headers.get("X-GitHub-Api-Version")).toBeTruthy();
    });

    it("throws GithubApiError on non-2xx", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ message: "Bad credentials" }, 401)
      );

      await expect(getAuthenticatedUser("bad")).rejects.toBeInstanceOf(
        GithubApiError
      );
    });
  });

  describe("listUserRepos", () => {
    it("normalises visibility and permissions", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 1,
            name: "repo-a",
            full_name: "octo/repo-a",
            owner: { login: "octo" },
            default_branch: "main",
            private: false,
            visibility: "public",
            description: "a",
            html_url: "https://github.com/octo/repo-a",
            clone_url: "https://github.com/octo/repo-a.git",
            pushed_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-02T00:00:00Z",
            archived: false,
            permissions: { admin: true, push: true, pull: true },
          },
          {
            id: 2,
            name: "repo-b",
            full_name: "octo/repo-b",
            owner: { login: "octo" },
            default_branch: "develop",
            private: true,
            description: null,
            html_url: "https://github.com/octo/repo-b",
            clone_url: "https://github.com/octo/repo-b.git",
            pushed_at: null,
            updated_at: null,
            archived: true,
            permissions: { admin: false, push: false, pull: true },
          },
        ])
      );

      const repos = await listUserRepos("tok");

      expect(repos).toHaveLength(2);
      expect(repos[0].visibility).toBe("public");
      expect(repos[1].visibility).toBe("private");
      expect(repos[1].archived).toBe(true);
      expect(repos[0].permissions.admin).toBe(true);
      expect(repos[1].permissions.admin).toBe(false);
    });

    it("passes pagination + affiliation params", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await listUserRepos("tok", {
        page: 3,
        perPage: 25,
        affiliation: ["owner"],
        sort: "pushed",
      });

      const [calledUrl] = fetchMock.mock.calls[0];
      const url = new URL(calledUrl);
      expect(url.searchParams.get("page")).toBe("3");
      expect(url.searchParams.get("per_page")).toBe("25");
      expect(url.searchParams.get("affiliation")).toBe("owner");
      expect(url.searchParams.get("sort")).toBe("pushed");
    });

    it("caps perPage at 100", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await listUserRepos("tok", { perPage: 1000 });
      const [calledUrl] = fetchMock.mock.calls[0];
      expect(new URL(calledUrl).searchParams.get("per_page")).toBe("100");
    });
  });

  describe("getRepo", () => {
    it("encodes owner/name correctly", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          id: 1,
          name: "repo a",
          full_name: "octo/repo a",
          owner: { login: "octo" },
          default_branch: "main",
          private: false,
          description: null,
          html_url: "x",
          clone_url: "y",
          pushed_at: null,
          updated_at: null,
          archived: false,
        })
      );

      await getRepo("tok", "octo", "repo a");

      const [calledUrl] = fetchMock.mock.calls[0];
      expect(calledUrl).toContain("/repos/octo/repo%20a");
    });
  });

  describe("exchangeCodeForToken", () => {
    it("returns normalized token fields on success", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          access_token: "ghu_xyz",
          refresh_token: "ghr_abc",
          expires_in: 3600,
          scope: "read:user repo",
          token_type: "bearer",
        })
      );

      const result = await exchangeCodeForToken({
        code: "code123",
        clientId: "id",
        clientSecret: "secret",
        redirectUri: "https://targ.example/callback",
      });

      expect(result.accessToken).toBe("ghu_xyz");
      expect(result.refreshToken).toBe("ghr_abc");
      expect(result.scope).toBe("read:user repo");
      expect(result.tokenType).toBe("bearer");
      expect(result.expiresAt).toBeInstanceOf(Date);

      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe("POST");
      expect(String(init.body)).toContain("code=code123");
    });

    it("throws on GitHub error payloads", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: "bad_verification_code",
            error_description: "The code is incorrect.",
          },
          200
        )
      );

      await expect(
        exchangeCodeForToken({
          code: "bad",
          clientId: "id",
          clientSecret: "secret",
          redirectUri: "https://targ.example/callback",
        })
      ).rejects.toBeInstanceOf(GithubApiError);
    });
  });

  describe("listCommitsForPath", () => {
    it("normalises the commit payload and prefers login as author", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            sha: "abc123",
            html_url: "https://github.com/octo/repo/commit/abc123",
            commit: {
              message: "fix: null check in checkout\n\nCo-authored-by: ...",
              author: {
                name: "Alice",
                email: "alice@example.com",
                date: "2026-04-15T12:34:56Z",
              },
            },
            author: { login: "alice" },
          },
        ])
      );

      const commits = await listCommitsForPath(
        "tok",
        "octo",
        "repo",
        "src/lib/checkout.ts"
      );

      expect(commits).toEqual([
        {
          sha: "abc123",
          message: "fix: null check in checkout\n\nCo-authored-by: ...",
          authorLogin: "alice",
          authorName: "Alice",
          authorEmail: "alice@example.com",
          date: "2026-04-15T12:34:56Z",
          htmlUrl: "https://github.com/octo/repo/commit/abc123",
        },
      ]);
    });

    it("falls back to commit.author.name when author.login is absent", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          {
            sha: "def456",
            html_url: "https://github.com/octo/repo/commit/def456",
            commit: {
              message: "refactor",
              author: {
                name: "Bob",
                email: "bob@example.com",
                date: "2026-04-01T00:00:00Z",
              },
            },
            author: null,
          },
        ])
      );

      const [commit] = await listCommitsForPath(
        "tok",
        "octo",
        "repo",
        "src/lib/other.ts"
      );
      expect(commit.authorLogin).toBeNull();
      expect(commit.authorName).toBe("Bob");
    });

    it("forwards path, ref, per_page, and since as query params", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));

      await listCommitsForPath("tok", "octo", "repo", "src/app/page.tsx", {
        ref: "abc123",
        perPage: 10,
        since: "2026-03-01T00:00:00Z",
      });

      const [calledUrl] = fetchMock.mock.calls[0];
      const url = new URL(calledUrl);
      expect(url.pathname).toBe("/repos/octo/repo/commits");
      expect(url.searchParams.get("path")).toBe("src/app/page.tsx");
      expect(url.searchParams.get("sha")).toBe("abc123");
      expect(url.searchParams.get("per_page")).toBe("10");
      expect(url.searchParams.get("since")).toBe("2026-03-01T00:00:00Z");
    });

    it("clamps perPage into [1, 100]", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await listCommitsForPath("tok", "octo", "repo", "x.ts", { perPage: 9999 });
      const [calledUrl] = fetchMock.mock.calls[0];
      expect(new URL(calledUrl).searchParams.get("per_page")).toBe("100");

      fetchMock.mockResolvedValueOnce(jsonResponse([]));
      await listCommitsForPath("tok", "octo", "repo", "x.ts", { perPage: 0 });
      const [calledUrl2] = fetchMock.mock.calls[1];
      expect(new URL(calledUrl2).searchParams.get("per_page")).toBe("1");
    });

    it("throws GithubApiError on non-2xx", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ message: "Not Found" }, 404)
      );
      await expect(
        listCommitsForPath("tok", "octo", "missing", "x.ts")
      ).rejects.toBeInstanceOf(GithubApiError);
    });
  });

  describe("getFileBlameRanges", () => {
    function blameResponse(
      ranges: Array<{
        startingLine: number;
        endingLine: number;
        oid: string;
        messageHeadline: string;
        committedDate: string;
        url?: string;
        login?: string | null;
        name?: string | null;
        email?: string | null;
        prNumber?: number;
      }>
    ): Response {
      return jsonResponse({
        data: {
          repository: {
            object: {
              blame: {
                ranges: ranges.map((r) => ({
                  startingLine: r.startingLine,
                  endingLine: r.endingLine,
                  commit: {
                    oid: r.oid,
                    messageHeadline: r.messageHeadline,
                    committedDate: r.committedDate,
                    url:
                      r.url ?? `https://github.com/octo/repo/commit/${r.oid}`,
                    author: {
                      user: r.login ? { login: r.login } : null,
                      name: r.name ?? r.login ?? "unknown",
                      email: r.email ?? null,
                    },
                    associatedPullRequests: {
                      nodes:
                        r.prNumber !== undefined
                          ? [{ number: r.prNumber }]
                          : [],
                    },
                  },
                })),
              },
            },
          },
        },
      });
    }

    it("issues a POST to /graphql with the right variables and bearer auth", async () => {
      fetchMock.mockResolvedValueOnce(blameResponse([]));

      await getFileBlameRanges(
        "ghu_tok",
        "octo",
        "repo",
        "abc123",
        "src/lib/x.ts"
      );

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.github.com/graphql");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer ghu_tok");
      expect(headers.get("Content-Type")).toBe("application/json");

      const body = JSON.parse(String(init.body));
      expect(body.variables).toEqual({
        owner: "octo",
        name: "repo",
        oid: "abc123",
        path: "src/lib/x.ts",
      });
      expect(body.query).toContain("blame(path: $path)");
    });

    it("normalises ranges, prefers login as author, and synthesizes (#PR) into message", async () => {
      fetchMock.mockResolvedValueOnce(
        blameResponse([
          {
            startingLine: 1,
            endingLine: 10,
            oid: "abc",
            messageHeadline: "fix: null check",
            committedDate: "2026-04-15T00:00:00Z",
            login: "alice",
            name: "Alice",
            email: "alice@example.com",
            prNumber: 842,
          },
          {
            startingLine: 11,
            endingLine: 20,
            oid: "def",
            messageHeadline: "refactor",
            committedDate: "2026-04-10T00:00:00Z",
            login: null,
            name: "Bob",
          },
        ])
      );

      const result = await getFileBlameRanges(
        "tok",
        "octo",
        "repo",
        "ref",
        "x.ts"
      );

      expect(result.ranges).toHaveLength(2);
      expect(result.ranges[0]).toMatchObject({
        startingLine: 1,
        endingLine: 10,
        commit: {
          sha: "abc",
          message: "fix: null check (#842)",
          authorLogin: "alice",
          authorName: "Alice",
          authorEmail: "alice@example.com",
        },
      });
      expect(result.ranges[1].commit.authorLogin).toBeNull();
      expect(result.ranges[1].commit.authorName).toBe("Bob");
      expect(result.ranges[1].commit.message).toBe("refactor");
    });

    it("computes mostRecentCommit by committedDate across ranges", async () => {
      fetchMock.mockResolvedValueOnce(
        blameResponse([
          {
            startingLine: 1,
            endingLine: 10,
            oid: "older",
            messageHeadline: "old",
            committedDate: "2026-04-01T00:00:00Z",
            login: "alice",
          },
          {
            startingLine: 11,
            endingLine: 20,
            oid: "newer",
            messageHeadline: "new",
            committedDate: "2026-04-19T00:00:00Z",
            login: "bob",
          },
        ])
      );
      const result = await getFileBlameRanges("t", "o", "r", "ref", "x.ts");
      expect(result.mostRecentCommit?.sha).toBe("newer");
    });

    it("returns an empty result when the file is missing at the ref", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: { repository: { object: null } },
        })
      );
      const result = await getFileBlameRanges("t", "o", "r", "ref", "missing.ts");
      expect(result.ranges).toEqual([]);
      expect(result.mostRecentCommit).toBeNull();
    });

    it("surfaces GraphQL errors as GithubApiError", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          errors: [{ message: "Variable $oid is invalid" }],
        })
      );
      await expect(
        getFileBlameRanges("t", "o", "r", "bad", "x.ts")
      ).rejects.toBeInstanceOf(GithubApiError);
    });

    it("throws GithubApiError on transport-level failure", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ message: "Bad credentials" }, 401)
      );
      await expect(
        getFileBlameRanges("bad-tok", "o", "r", "ref", "x.ts")
      ).rejects.toBeInstanceOf(GithubApiError);
    });
  });
});
