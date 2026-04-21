import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  diffDistanceToLine,
  diffTouchesLine,
  exchangeCodeForToken,
  getAuthenticatedUser,
  getCommitDiff,
  getFileBlameRanges,
  getRepo,
  GithubApiError,
  listCommitsForPath,
  listUserRepos,
  parseUnifiedDiffHunks,
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

  // -------------------------------------------------------------------------
  // Phase 2.9 — commit diff + hunk parsing
  // -------------------------------------------------------------------------

  describe("parseUnifiedDiffHunks", () => {
    it("extracts new-file ranges from a multi-hunk patch", () => {
      const patch = [
        "@@ -10,7 +10,8 @@ context",
        " a",
        "-b",
        "+b-new",
        "+c",
        " d",
        "@@ -100,3 +110,3 @@ context",
        " x",
        "-y",
        "+y-new",
      ].join("\n");
      const hunks = parseUnifiedDiffHunks(patch);
      expect(hunks).toEqual([
        { oldStart: 10, oldLines: 7, newStart: 10, newLines: 8 },
        { oldStart: 100, oldLines: 3, newStart: 110, newLines: 3 },
      ]);
    });

    it("defaults line counts to 1 when omitted (single-line change)", () => {
      // `@@ -5 +5 @@` is valid unified-diff syntax for a 1-line hunk.
      const hunks = parseUnifiedDiffHunks("@@ -5 +5 @@\n-a\n+b");
      expect(hunks).toEqual([
        { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 },
      ]);
    });

    it("returns empty array for undefined, empty, or malformed input", () => {
      expect(parseUnifiedDiffHunks(undefined)).toEqual([]);
      expect(parseUnifiedDiffHunks("")).toEqual([]);
      // No `@@` header → binary file or text we can't parse.
      expect(parseUnifiedDiffHunks("no hunks here")).toEqual([]);
    });

    it("skips hunks with non-finite numbers without throwing", () => {
      // This shouldn't happen in practice but defends against corrupt
      // patches leaking NaN ranges into the scorer.
      const hunks = parseUnifiedDiffHunks("@@ -abc,7 +10,8 @@");
      expect(hunks).toEqual([]);
    });
  });

  describe("getCommitDiff", () => {
    it("fetches the commit detail endpoint and parses per-file hunks", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          sha: "abc123",
          files: [
            {
              filename: "src/checkout.ts",
              status: "modified",
              additions: 3,
              deletions: 1,
              patch: "@@ -40,5 +40,7 @@ ctx\n a\n-b\n+b2\n+c\n+d",
            },
            {
              filename: "README.md",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1,2 +1,3 @@\n x\n+y",
            },
          ],
        })
      );

      const diff = await getCommitDiff("token", "acme", "checkout", "abc123");

      const call = fetchMock.mock.calls[0];
      expect(call[0]).toContain("/repos/acme/checkout/commits/abc123");
      expect(diff.sha).toBe("abc123");
      expect(diff.truncated).toBe(false);
      expect(diff.files).toHaveLength(2);
      expect(diff.files[0]).toMatchObject({
        path: "src/checkout.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
      });
      expect(diff.files[0].hunks).toEqual([
        { oldStart: 40, oldLines: 5, newStart: 40, newLines: 7 },
      ]);
    });

    it("flags truncated=true when a modified file has no patch", async () => {
      // GitHub returns `patch: undefined` for files beyond the 1MB cap
      // or for binary files. We want callers to know the signal is
      // incomplete for this commit.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          sha: "big",
          files: [
            {
              filename: "huge.txt",
              status: "modified",
              additions: 1000,
              deletions: 1000,
              // No patch — file exceeded the size limit.
            },
          ],
        })
      );

      const diff = await getCommitDiff("t", "o", "r", "big");
      expect(diff.truncated).toBe(true);
      expect(diff.files[0].hunks).toEqual([]);
    });

    it("does NOT flag truncation for removed/renamed files without patches", async () => {
      // Removed files legitimately lack a patch on the post-change
      // side. This isn't truncation.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          sha: "rm",
          files: [
            {
              filename: "gone.ts",
              status: "removed",
              additions: 0,
              deletions: 5,
            },
            {
              filename: "new.ts",
              previous_filename: "old.ts",
              status: "renamed",
              additions: 0,
              deletions: 0,
            },
          ],
        })
      );

      const diff = await getCommitDiff("t", "o", "r", "rm");
      expect(diff.truncated).toBe(false);
      expect(diff.files[1].previousPath).toBe("old.ts");
    });

    it("handles missing files array (empty commit edge case)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ sha: "empty" }));
      const diff = await getCommitDiff("t", "o", "r", "empty");
      expect(diff.files).toEqual([]);
      expect(diff.truncated).toBe(false);
    });

    it("normalises unknown status strings to 'changed'", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          sha: "weird",
          files: [
            {
              filename: "a.ts",
              status: "frobnicated",
              patch: "@@ -1 +1 @@\n-x\n+y",
            },
          ],
        })
      );
      const diff = await getCommitDiff("t", "o", "r", "weird");
      expect(diff.files[0].status).toBe("changed");
    });
  });

  describe("diffTouchesLine", () => {
    const diff = {
      sha: "x",
      truncated: false,
      files: [
        {
          path: "src/a.ts",
          previousPath: null,
          status: "modified" as const,
          additions: 3,
          deletions: 1,
          hunks: [
            { oldStart: 10, oldLines: 5, newStart: 10, newLines: 7 },
            { oldStart: 40, oldLines: 2, newStart: 42, newLines: 2 },
          ],
        },
        {
          path: "src/renamed.ts",
          previousPath: "src/old.ts",
          status: "renamed" as const,
          additions: 1,
          deletions: 0,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
        },
      ],
    };

    it("returns true when the line falls inside any new-file hunk range", () => {
      // First hunk covers lines [10, 17). Line 15 is inside.
      expect(diffTouchesLine(diff, "src/a.ts", 15)).toBe(true);
      // Exact start.
      expect(diffTouchesLine(diff, "src/a.ts", 10)).toBe(true);
      // Last line in the hunk: newStart + newLines - 1 = 16.
      expect(diffTouchesLine(diff, "src/a.ts", 16)).toBe(true);
    });

    it("returns false for lines just outside every hunk", () => {
      expect(diffTouchesLine(diff, "src/a.ts", 9)).toBe(false);
      // Line 17 = newStart + newLines (exclusive upper bound).
      expect(diffTouchesLine(diff, "src/a.ts", 17)).toBe(false);
      // Between hunks.
      expect(diffTouchesLine(diff, "src/a.ts", 30)).toBe(false);
    });

    it("matches renamed files on either new or previous path", () => {
      expect(diffTouchesLine(diff, "src/renamed.ts", 1)).toBe(true);
      expect(diffTouchesLine(diff, "src/old.ts", 1)).toBe(true);
    });

    it("returns false for unknown files, zero/negative lines, NaN", () => {
      expect(diffTouchesLine(diff, "src/other.ts", 15)).toBe(false);
      expect(diffTouchesLine(diff, "src/a.ts", 0)).toBe(false);
      expect(diffTouchesLine(diff, "src/a.ts", -1)).toBe(false);
      expect(diffTouchesLine(diff, "src/a.ts", Number.NaN)).toBe(false);
    });

    it("skips pure-deletion hunks (newLines === 0)", () => {
      const delOnly = {
        sha: "d",
        truncated: false,
        files: [
          {
            path: "src/a.ts",
            previousPath: null,
            status: "modified" as const,
            additions: 0,
            deletions: 3,
            hunks: [{ oldStart: 10, oldLines: 3, newStart: 9, newLines: 0 }],
          },
        ],
      };
      // newStart 9 + newLines 0 → the hunk covers no post-change line.
      expect(diffTouchesLine(delOnly, "src/a.ts", 9)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2.9.1 — line proximity
  // -------------------------------------------------------------------------

  describe("diffDistanceToLine", () => {
    const diff = {
      sha: "x",
      truncated: false,
      files: [
        {
          path: "src/a.ts",
          previousPath: null,
          status: "modified" as const,
          additions: 2,
          deletions: 1,
          hunks: [
            // Covers lines [10, 16].
            { oldStart: 10, oldLines: 5, newStart: 10, newLines: 7 },
            // Covers lines [42, 43].
            { oldStart: 40, oldLines: 2, newStart: 42, newLines: 2 },
          ],
        },
        {
          path: "src/renamed.ts",
          previousPath: "src/old.ts",
          status: "renamed" as const,
          additions: 1,
          deletions: 0,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 5, newLines: 3 }],
        },
      ],
    };

    it("returns 0 when the line is exactly inside a hunk", () => {
      expect(diffDistanceToLine(diff, "src/a.ts", 10)).toBe(0);
      expect(diffDistanceToLine(diff, "src/a.ts", 13)).toBe(0);
      expect(diffDistanceToLine(diff, "src/a.ts", 16)).toBe(0);
    });

    it("returns positive distance to the nearest hunk edge for misses", () => {
      // Hunk ends at 16, line is 20 → distance 4.
      expect(diffDistanceToLine(diff, "src/a.ts", 20)).toBe(4);
      // Line 9 is 1 above hunk start (10).
      expect(diffDistanceToLine(diff, "src/a.ts", 9)).toBe(1);
      // Between hunks: line 30. Hunk A ends at 16, Hunk B starts at
      // 42 → distances 14 and 12 respectively → min = 12.
      expect(diffDistanceToLine(diff, "src/a.ts", 30)).toBe(12);
      // Past the last hunk.
      expect(diffDistanceToLine(diff, "src/a.ts", 50)).toBe(7);
    });

    it("honours rename path aliasing (old path still resolves)", () => {
      // Renamed file's hunk covers new-lines [5, 7]. Old path
      // accesses the same hunk.
      expect(diffDistanceToLine(diff, "src/old.ts", 5)).toBe(0);
      expect(diffDistanceToLine(diff, "src/renamed.ts", 1)).toBe(4);
    });

    it("returns null for unknown files, invalid lines, or pure-deletion hunks", () => {
      expect(diffDistanceToLine(diff, "src/other.ts", 10)).toBeNull();
      expect(diffDistanceToLine(diff, "src/a.ts", 0)).toBeNull();
      expect(diffDistanceToLine(diff, "src/a.ts", -1)).toBeNull();
      expect(diffDistanceToLine(diff, "src/a.ts", Number.NaN)).toBeNull();

      const delOnly = {
        sha: "d",
        truncated: false,
        files: [
          {
            path: "src/a.ts",
            previousPath: null,
            status: "modified" as const,
            additions: 0,
            deletions: 2,
            hunks: [{ oldStart: 10, oldLines: 2, newStart: 9, newLines: 0 }],
          },
        ],
      };
      // Every hunk is pure-deletion → no post-change coordinate to
      // distance against → null (NOT 0 or some made-up number).
      expect(diffDistanceToLine(delOnly, "src/a.ts", 15)).toBeNull();
    });

    it("diffTouchesLine is a thin predicate over diffDistanceToLine (exact hit only)", () => {
      expect(diffTouchesLine(diff, "src/a.ts", 13)).toBe(true);
      // Line 20 has distance 4 — near but not exact → predicate is false.
      expect(diffTouchesLine(diff, "src/a.ts", 20)).toBe(false);
    });
  });
});
