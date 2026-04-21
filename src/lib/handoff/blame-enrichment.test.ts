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
  enrichBlame,
  extractPrNumber,
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

function fakeCtx(responses: Record<string, BlameCommit[]>): BlameContext {
  return {
    listCommitsForPath: async (path) => responses[path] ?? [],
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

  it("dedupes file queries so each distinct file is asked for once", async () => {
    const listSpy = vi.fn(async (): Promise<BlameCommit[]> => []);
    const input = enrichment({
      affectedAreaLocation: loc("src/lib/a.ts"),
      stackLocations: [loc("src/lib/a.ts", 10), loc("src/lib/a.ts", 20)],
      evidenceLocations: {
        "ev-1": [loc("src/lib/a.ts", 30)],
      },
    });
    await enrichBlame(input, { listCommitsForPath: listSpy });
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith("src/lib/a.ts");
  });

  it("continues gracefully when one file's lookup throws", async () => {
    const input = enrichment({
      affectedAreaLocation: loc("src/lib/a.ts"),
      stackLocations: [loc("src/lib/b.ts", 20)],
    });

    const ctx: BlameContext = {
      listCommitsForPath: async (path) => {
        if (path === "src/lib/a.ts") throw new Error("rate limited");
        return [
          commit({
            sha: "sha-b",
            date: "2026-04-19T00:00:00Z",
          }),
        ];
      },
    };

    const result = await enrichBlame(input, ctx);
    // a.ts has no blame; b.ts does.
    expect(result.enrichment.affectedAreaLocation?.blame).toBeUndefined();
    expect(result.enrichment.stackLocations?.[0].blame?.commitSha).toBe("sha-b");
    expect(result.filesQueried).toEqual(["src/lib/b.ts"]);
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
