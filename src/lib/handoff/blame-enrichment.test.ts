/**
 * Tests for the pure blame-enrichment adapter (Phase 2.5).
 *
 * We inject a fake `listCommitsForPath` closure so we can assert:
 *   - Blame is attached to every location whose file we have data for.
 *   - Duplicate files are only queried once (service layer's job is to
 *     cache, but the adapter still deduplicates its own input set).
 *   - Suspected regressions are ranked by (file-hit-count, recency, sha).
 *   - Old commits are filtered out of regressions but still count as blame.
 *   - PR numbers are parsed from commit messages.
 *   - A failing file lookup doesn't take the whole enrichment down.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  RepoEnrichmentInput,
  RepoLocation,
} from "@/lib/handoff/packet";

import {
  collectUniqueFiles,
  collectUniqueLocationKeys,
  enrichBlame,
  extractPrNumber,
  keyOf,
  rankSuspectedRegressions,
  type BlameCommit,
  type BlameContext,
} from "./blame-enrichment";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commit(overrides: Partial<BlameCommit> & { sha: string }): BlameCommit {
  return {
    message: "chore: default",
    authorLogin: "alice",
    authorName: "Alice",
    date: new Date().toISOString(),
    htmlUrl: `https://github.com/acme/checkout/commit/${overrides.sha}`,
    ...overrides,
  };
}

function enrichment(
  overrides: Partial<RepoEnrichmentInput> = {}
): RepoEnrichmentInput {
  return {
    repoFullName: "acme/checkout",
    ref: "deadbeef",
    ...overrides,
  };
}

function loc(file: string, line?: number): RepoLocation {
  return line !== undefined ? { file, line } : { file };
}

/// Builds a `BlameContext` that mirrors the file-level Phase 2.5 behaviour:
/// `resolveLineBlame` returns the first commit in the file's response (i.e.
/// the most-recent commit), regardless of line. Used for tests that don't
/// care about the line-level distinction.
function fakeCtx(responses: Record<string, BlameCommit[]>): BlameContext {
  return {
    resolveLineBlame: async (file) => responses[file]?.[0] ?? null,
    listRecentCommits: async (file) => responses[file] ?? [],
  };
}

/// Builds a `BlameContext` whose `resolveLineBlame` returns DIFFERENT
/// commits for different lines on the same file. Used for the Phase 2.6
/// line-level tests that prove distinct lines get distinct attribution.
function lineLevelCtx(
  blameByLocation: Record<string, BlameCommit | null>,
  recentCommits: Record<string, BlameCommit[]> = {}
): BlameContext {
  return {
    resolveLineBlame: async (file, line) =>
      blameByLocation[`${file}:${line ?? ""}`] ?? null,
    listRecentCommits: async (file) => recentCommits[file] ?? [],
  };
}

// ---------------------------------------------------------------------------
// extractPrNumber
// ---------------------------------------------------------------------------

describe("extractPrNumber", () => {
  it("parses the GitHub squash-merge suffix", () => {
    expect(
      extractPrNumber("fix: null check in checkout (#842)")
    ).toBe(842);
  });

  it("parses the GitHub merge-commit prefix", () => {
    expect(extractPrNumber("Merge pull request #1234 from foo/bar")).toBe(1234);
  });

  it("only looks at the first line of the message", () => {
    // A #NNN in the body should be ignored so we don't grab issue refs.
    expect(
      extractPrNumber(
        "fix: null check\n\nCloses #999 — see discussion in #777"
      )
    ).toBeNull();
  });

  it("returns null when no PR number is present", () => {
    expect(extractPrNumber("chore: bump deps")).toBeNull();
  });

  it("rejects numbers longer than 6 digits (noise guard)", () => {
    expect(extractPrNumber("ref #1234567")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectUniqueFiles
// ---------------------------------------------------------------------------

describe("collectUniqueFiles", () => {
  it("deduplicates across affected area, stack, and evidence buckets", () => {
    const files = collectUniqueFiles(
      enrichment({
        affectedAreaLocation: loc("src/lib/a.ts"),
        stackLocations: [loc("src/lib/a.ts", 10), loc("src/lib/b.ts", 20)],
        evidenceLocations: {
          "ev-1": [loc("src/lib/b.ts", 30), loc("src/lib/c.ts")],
          "ev-2": [loc("src/lib/a.ts", 40)],
        },
      })
    );
    expect(files).toEqual(["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts"]);
  });

  it("returns an empty list when no locations are set", () => {
    expect(collectUniqueFiles(enrichment())).toEqual([]);
  });
});

describe("collectUniqueLocationKeys", () => {
  it("dedupes by (file, line) pair, not by file alone", () => {
    const keys = collectUniqueLocationKeys(
      enrichment({
        affectedAreaLocation: loc("src/lib/a.ts"),
        stackLocations: [
          loc("src/lib/a.ts", 10),
          loc("src/lib/a.ts", 10), // duplicate, dropped
          loc("src/lib/a.ts", 20),
        ],
        evidenceLocations: {
          "ev-1": [loc("src/lib/a.ts"), loc("src/lib/b.ts", 5)],
        },
      })
    );
    // Expected unique keys:
    //   (a.ts, undefined)  — from affectedArea + ev-1 path-only
    //   (a.ts, 10)         — from stack
    //   (a.ts, 20)         — from stack
    //   (b.ts, 5)          — from ev-1
    expect(keys).toEqual([
      { file: "src/lib/a.ts", line: undefined },
      { file: "src/lib/a.ts", line: 10 },
      { file: "src/lib/a.ts", line: 20 },
      { file: "src/lib/b.ts", line: 5 },
    ]);
  });

  it("keys are stable strings: file + null-byte + line (or empty string)", () => {
    expect(keyOf({ file: "x.ts", line: 42 })).toBe("x.ts\u000042");
    expect(keyOf({ file: "x.ts", line: undefined })).toBe("x.ts\u0000");
    // Different lines → different keys; same line → same key.
    expect(keyOf({ file: "x.ts", line: 1 })).not.toBe(
      keyOf({ file: "x.ts", line: 2 })
    );
  });
});

// ---------------------------------------------------------------------------
// rankSuspectedRegressions
// ---------------------------------------------------------------------------

describe("rankSuspectedRegressions", () => {
  const now = new Date("2026-04-20T00:00:00Z");

  it("ranks commits touching more files first", () => {
    const commitsByFile = new Map<string, BlameCommit[]>([
      [
        "src/a.ts",
        [
          commit({ sha: "shared", date: "2026-04-19T12:00:00Z" }),
          commit({ sha: "only-a", date: "2026-04-18T00:00:00Z" }),
        ],
      ],
      [
        "src/b.ts",
        [commit({ sha: "shared", date: "2026-04-19T12:00:00Z" })],
      ],
    ]);
    const ranked = rankSuspectedRegressions(
      commitsByFile,
      ["src/a.ts", "src/b.ts"],
      { now }
    );
    expect(ranked.map((c) => c.sha)).toEqual(["shared", "only-a"]);
    const shared = ranked.find((c) => c.sha === "shared");
    expect(shared?.touchedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("excludes commits older than the recency window", () => {
    const commitsByFile = new Map<string, BlameCommit[]>([
      [
        "src/a.ts",
        [
          commit({ sha: "recent", date: "2026-04-15T00:00:00Z" }),
          commit({ sha: "ancient", date: "2025-01-01T00:00:00Z" }),
        ],
      ],
    ]);
    const ranked = rankSuspectedRegressions(commitsByFile, ["src/a.ts"], {
      now,
      daysWindow: 30,
    });
    expect(ranked.map((c) => c.sha)).toEqual(["recent"]);
  });

  it("caps the output list at maxResults", () => {
    const commitsByFile = new Map<string, BlameCommit[]>([
      [
        "src/a.ts",
        Array.from({ length: 10 }, (_, i) =>
          commit({
            sha: `sha-${i}`,
            date: new Date(2026, 3, 10 + i).toISOString(),
          })
        ),
      ],
    ]);
    const ranked = rankSuspectedRegressions(commitsByFile, ["src/a.ts"], {
      now: new Date("2026-04-25T00:00:00Z"),
      maxResults: 3,
    });
    expect(ranked).toHaveLength(3);
  });

  it("breaks ties on (recency, sha)", () => {
    const sameDate = "2026-04-15T00:00:00Z";
    const commitsByFile = new Map<string, BlameCommit[]>([
      [
        "src/a.ts",
        [
          commit({ sha: "zzz", date: sameDate }),
          commit({ sha: "aaa", date: sameDate }),
        ],
      ],
    ]);
    const ranked = rankSuspectedRegressions(commitsByFile, ["src/a.ts"], { now });
    expect(ranked.map((c) => c.sha)).toEqual(["aaa", "zzz"]);
  });

  it("exposes the pr number when the message contains one", () => {
    const commitsByFile = new Map<string, BlameCommit[]>([
      [
        "src/a.ts",
        [
          commit({
            sha: "abc",
            message: "fix: checkout null ref (#842)",
            date: "2026-04-18T00:00:00Z",
          }),
        ],
      ],
    ]);
    const [ranked] = rankSuspectedRegressions(commitsByFile, ["src/a.ts"], {
      now,
    });
    expect(ranked.prNumber).toBe(842);
    expect(ranked.url).toContain("commit/abc");
  });
});

// ---------------------------------------------------------------------------
// enrichBlame
// ---------------------------------------------------------------------------

describe("enrichBlame", () => {
  const now = new Date("2026-04-20T00:00:00Z");

  it("returns the input unchanged when there are no locations", async () => {
    const input = enrichment();
    const result = await enrichBlame(input, fakeCtx({}));
    expect(result.enrichment).toEqual(input);
    expect(result.filesQueried).toEqual([]);
  });

  it("attaches blame to affected area, stack, and evidence locations", async () => {
    const input = enrichment({
      affectedAreaLocation: loc("src/lib/a.ts"),
      stackLocations: [loc("src/lib/a.ts", 10)],
      evidenceLocations: {
        "ev-1": [loc("src/lib/b.ts", 30)],
      },
    });

    const ctx = fakeCtx({
      "src/lib/a.ts": [
        commit({
          sha: "sha-a",
          message: "fix: a (#11)",
          authorLogin: "alice",
          date: "2026-04-18T00:00:00Z",
        }),
      ],
      "src/lib/b.ts": [
        commit({
          sha: "sha-b",
          message: "refactor: b",
          authorLogin: null,
          authorName: "Bob",
          date: "2026-04-17T00:00:00Z",
        }),
      ],
    });

    const result = await enrichBlame(input, ctx);
    expect(result.enrichment.affectedAreaLocation?.blame).toMatchObject({
      author: "alice",
      commitSha: "sha-a",
      commitMessage: "fix: a (#11)",
      prNumber: 11,
      date: "2026-04-18T00:00:00Z",
    });
    expect(result.enrichment.stackLocations?.[0].blame?.commitSha).toBe("sha-a");
    expect(
      result.enrichment.evidenceLocations?.["ev-1"][0].blame
    ).toMatchObject({
      author: "Bob",
      commitSha: "sha-b",
    });
  });

  it("dedupes regression queries so each distinct file is asked for once", async () => {
    const listSpy = vi.fn(async (): Promise<BlameCommit[]> => []);
    const blameSpy = vi.fn(async (): Promise<BlameCommit | null> => null);
    const input = enrichment({
      affectedAreaLocation: loc("src/lib/a.ts"),
      // Same file with different lines — DIFFERENT blame lookups (line-level)
      // but a SINGLE recent-commits lookup (regression aggregation is
      // file-level).
      stackLocations: [loc("src/lib/a.ts", 10), loc("src/lib/a.ts", 20)],
      evidenceLocations: {
        "ev-1": [loc("src/lib/a.ts", 30)],
      },
    });
    await enrichBlame(input, {
      resolveLineBlame: blameSpy,
      listRecentCommits: listSpy,
    });
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith("src/lib/a.ts");
    // 4 distinct (file, line) keys: (a.ts, undefined), (a.ts, 10),
    // (a.ts, 20), (a.ts, 30). Each gets its own blame call.
    expect(blameSpy).toHaveBeenCalledTimes(4);
  });

  it("continues gracefully when one file's lookup throws", async () => {
    const input = enrichment({
      affectedAreaLocation: loc("src/lib/a.ts"),
      stackLocations: [loc("src/lib/b.ts", 20)],
    });

    const ctx: BlameContext = {
      resolveLineBlame: async (file) => {
        if (file === "src/lib/a.ts") throw new Error("rate limited");
        return commit({ sha: "sha-b", date: "2026-04-19T00:00:00Z" });
      },
      listRecentCommits: async (file) => {
        if (file === "src/lib/a.ts") throw new Error("rate limited");
        return [commit({ sha: "sha-b", date: "2026-04-19T00:00:00Z" })];
      },
    };

    const result = await enrichBlame(input, ctx);
    // a.ts has no blame; b.ts does.
    expect(result.enrichment.affectedAreaLocation?.blame).toBeUndefined();
    expect(result.enrichment.stackLocations?.[0].blame?.commitSha).toBe("sha-b");
    expect(result.filesQueried).toEqual(["src/lib/b.ts"]);
  });

  // -----------------------------------------------------------------------
  // Phase 2.6 — line-level blame
  // -----------------------------------------------------------------------

  it("attaches DIFFERENT blame to two locations on the same file with different lines", async () => {
    const input = enrichment({
      stackLocations: [loc("src/lib/a.ts", 10), loc("src/lib/a.ts", 50)],
    });
    const ctx = lineLevelCtx({
      "src/lib/a.ts:10": commit({ sha: "early", authorLogin: "alice" }),
      "src/lib/a.ts:50": commit({ sha: "later", authorLogin: "bob" }),
    });
    const result = await enrichBlame(input, ctx);
    expect(result.enrichment.stackLocations?.[0].blame?.commitSha).toBe("early");
    expect(result.enrichment.stackLocations?.[0].blame?.author).toBe("alice");
    expect(result.enrichment.stackLocations?.[1].blame?.commitSha).toBe("later");
    expect(result.enrichment.stackLocations?.[1].blame?.author).toBe("bob");
    expect(result.locationsBlamed).toBe(2);
  });

  it("falls back to file-level blame for path-only locations (line undefined)", async () => {
    const input = enrichment({
      affectedAreaLocation: loc("src/lib/a.ts"),
    });
    const ctx = lineLevelCtx({
      // The (file, undefined) key resolves to whatever the closure decides
      // — typically "most recent commit on the whole file".
      "src/lib/a.ts:": commit({ sha: "file-level", authorLogin: "alice" }),
    });
    const result = await enrichBlame(input, ctx);
    expect(result.enrichment.affectedAreaLocation?.blame?.commitSha).toBe(
      "file-level"
    );
  });

  it("does not double-count lines on the same file in the regression hit count", async () => {
    const input = enrichment({
      // Two distinct (file, line) entries on the SAME file → blame fans
      // out per line, but `commitsByFile` for regression scoring still has
      // one entry → fileHitCount = 1.
      stackLocations: [loc("src/a.ts", 10), loc("src/a.ts", 50)],
    });
    const shared = commit({
      sha: "shared",
      message: "fix: hot path (#7)",
      date: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const ctx: BlameContext = {
      resolveLineBlame: async () => shared,
      listRecentCommits: async () => [shared],
    };
    const result = await enrichBlame(input, ctx);
    expect(result.enrichment.suspectedRegressions?.[0]).toMatchObject({
      sha: "shared",
      // touchedFiles has just one file, despite two (file, line) hits.
      touchedFiles: ["src/a.ts"],
    });
  });

  it("reports locationsBlamed independently from filesQueried", async () => {
    const input = enrichment({
      stackLocations: [
        loc("src/a.ts", 10),
        loc("src/a.ts", 20),
        loc("src/b.ts", 30),
      ],
    });
    const ctx: BlameContext = {
      resolveLineBlame: async (file, line) =>
        commit({ sha: `${file}-${line}` }),
      listRecentCommits: async (file) => [commit({ sha: `recent-${file}` })],
    };
    const result = await enrichBlame(input, ctx);
    expect(result.filesQueried.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // 3 distinct (file, line) keys → 3 blame attributions.
    expect(result.locationsBlamed).toBe(3);
  });

  it("populates suspectedRegressions from recent commits across files", async () => {
    const input = enrichment({
      stackLocations: [loc("src/a.ts"), loc("src/b.ts")],
    });
    const shared = commit({
      sha: "shared",
      message: "fix: both (#123)",
      date: "2026-04-18T00:00:00Z",
    });
    const ctx: BlameContext = {
      ...fakeCtx({
        "src/a.ts": [
          shared,
          commit({ sha: "only-a", date: "2026-04-17T00:00:00Z" }),
        ],
        "src/b.ts": [shared],
      }),
      now,
    };
    const result = await enrichBlame(input, ctx);
    expect(result.enrichment.suspectedRegressions?.map((c) => c.sha)).toEqual([
      "shared",
      "only-a",
    ]);
    expect(result.enrichment.suspectedRegressions?.[0].touchedFiles).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("does not emit a suspectedRegressions field when every commit is too old", async () => {
    const input = enrichment({
      stackLocations: [loc("src/a.ts")],
    });
    const ctx: BlameContext = {
      ...fakeCtx({
        "src/a.ts": [commit({ sha: "ancient", date: "2024-01-01T00:00:00Z" })],
      }),
      now,
    };
    const result = await enrichBlame(input, ctx);
    // Blame still attaches (no recency filter on blame) but no regressions.
    expect(result.enrichment.stackLocations?.[0].blame?.commitSha).toBe(
      "ancient"
    );
    expect(result.enrichment.suspectedRegressions).toBeUndefined();
  });
});
