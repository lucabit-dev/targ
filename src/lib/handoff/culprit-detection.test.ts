/**
 * Tests for the culprit-detection adapter (Phase 2.7).
 *
 * Covers:
 *   - tokenization (stopwords, length floor, lowercase)
 *   - per-signal scoring (affected area, root cause, summary, files,
 *     recency)
 *   - confidence-band thresholds (medium/high gates + gap rule)
 *   - tie-breaking determinism (by date, then SHA)
 *   - the higher-level `detectLikelyCulpritFromEnrichment` wrapper
 */

import { describe, expect, it } from "vitest";

import type { CommitRef, RepoEnrichmentInput } from "@/lib/handoff/packet";

import {
  detectLikelyCulprit,
  detectLikelyCulpritFromEnrichment,
  tokenize,
} from "./culprit-detection";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function commit(overrides: Partial<CommitRef> = {}): CommitRef {
  return {
    sha: "abc",
    message: "fix: payment retry race",
    author: "alice",
    date: "2026-04-19T00:00:00Z",
    touchedFiles: ["src/lib/checkout.ts"],
    ...overrides,
  };
}

const NOW = new Date("2026-04-20T00:00:00Z");

// ---------------------------------------------------------------------------
// tokenize()
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("lowercases and filters short tokens (< 3 chars)", () => {
    expect(tokenize("Fix UI to make X work")).toEqual(
      new Set(["make", "work"])
    );
  });

  it("strips standard stopwords (the, in, of, ...)", () => {
    // Note: 'bug' is also in our stopword list (bug-report noise), so it
    // gets stripped even from this 'standard stopwords' fixture.
    expect(tokenize("the failure in the checkout flow")).toEqual(
      new Set(["failure", "checkout", "flow"])
    );
  });

  it("strips bug-report stopwords (fix, bug, patch, pr, ...)", () => {
    expect(tokenize("fix: fixes bug in patch (PR #42)")).toEqual(new Set());
  });

  it("returns empty set for undefined / empty / whitespace", () => {
    expect(tokenize(undefined)).toEqual(new Set());
    expect(tokenize("")).toEqual(new Set());
    expect(tokenize("   \n\t  ")).toEqual(new Set());
  });

  it("splits on every non-alphanumeric char", () => {
    expect(tokenize("payment-retry/race-condition")).toEqual(
      new Set(["payment", "retry", "race", "condition"])
    );
  });
});

// ---------------------------------------------------------------------------
// detectLikelyCulprit() — basic flow + confidence bands
// ---------------------------------------------------------------------------

describe("detectLikelyCulprit", () => {
  it("returns null when there are no regressions", () => {
    const result = detectLikelyCulprit([], { affectedArea: "checkout" });
    expect(result).toEqual({ culprit: null, topScore: 0, runnerUpSha: null });
  });

  it("returns null when no candidate clears the medium threshold", () => {
    // Commit message doesn't match anything; no resolved files; older than
    // the recent window. Score should be 0.
    const result = detectLikelyCulprit(
      [
        commit({
          sha: "noise",
          message: "chore: update copyright year",
          date: "2026-01-01T00:00:00Z",
        }),
      ],
      {
        affectedArea: "checkout flow",
        probableRootCause: "race condition in payment",
        now: NOW,
      }
    );
    expect(result.culprit).toBeNull();
    expect(result.topScore).toBe(0);
  });

  it("picks a single matching commit at medium confidence", () => {
    const c = commit({
      sha: "good",
      message: "fix: handle race in checkout retry",
      date: "2026-04-18T00:00:00Z", // 2 days ago — inside recent window
    });
    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout flow",
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("good");
    // Score: W_AREA_HIT (2) + W_RECENT_MERGE (0.5) = 2.5 → medium.
    expect(result.culprit?.confidence).toBe("medium");
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("matches affected area"),
        expect.stringContaining("merged"),
      ])
    );
  });

  it("escalates to high confidence when score AND gap clear the high bar", () => {
    const winner = commit({
      sha: "winner",
      message: "fix: payment retry race in checkout flow",
      // Message hits 3 area tokens (payment, retry, race) → +2 base + 1 overlap
      // bonus + 1.5 cause + ratio bonus.
      touchedFiles: ["src/lib/checkout.ts", "src/lib/payment.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const filler = commit({
      sha: "filler",
      message: "chore: bump dep",
      touchedFiles: ["package.json"],
      date: "2026-04-15T00:00:00Z",
    });
    const result = detectLikelyCulprit([winner, filler], {
      affectedArea: "checkout flow payment retry",
      probableRootCause: "race condition",
      resolvedFiles: ["src/lib/checkout.ts", "src/lib/payment.ts"],
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("winner");
    expect(result.culprit?.confidence).toBe("high");
  });

  it("stays at medium when the gap to runner-up is too small", () => {
    // Two commits both match the area strongly. Score gap shrinks → medium.
    const a = commit({
      sha: "aaaa",
      message: "fix: checkout payment retry",
      touchedFiles: ["src/lib/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const b = commit({
      sha: "bbbb",
      message: "fix: payment retry checkout",
      touchedFiles: ["src/lib/checkout.ts"],
      date: "2026-04-18T00:00:00Z",
    });
    const result = detectLikelyCulprit([a, b], {
      affectedArea: "checkout payment retry",
      now: NOW,
    });
    expect(result.culprit).not.toBeNull();
    // Both commits score identically → tie-break picks one but confidence
    // can't be high (gap = 0).
    expect(result.culprit?.confidence).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// Scoring details
// ---------------------------------------------------------------------------

describe("detectLikelyCulprit — scoring", () => {
  it("does not double-count tokens shared between affectedArea and probableRootCause", () => {
    // The word "checkout" appears in BOTH signals. The second one should
    // be deduped — otherwise a commit that says "checkout" once would
    // get credit twice.
    const c = commit({
      sha: "c",
      message: "fix: checkout",
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout",
      probableRootCause: "checkout",
      now: NOW,
    });
    // Should only get the area hit (2) + recency (0.5) = 2.5.
    // If we double-counted cause, we'd get 4 → high confidence.
    expect(result.culprit?.confidence).toBe("medium");
    expect(result.topScore).toBeCloseTo(2.5, 5);
  });

  it("rewards file-hit ratio independently from message keywords", () => {
    // Commit message is unrelated, but it touched 2 of 2 resolved files.
    const c = commit({
      sha: "files-only",
      message: "refactor: extract helper",
      touchedFiles: ["src/a.ts", "src/b.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([c], {
      affectedArea: "something completely different",
      resolvedFiles: ["src/a.ts", "src/b.ts"],
      now: NOW,
    });
    // 2/2 ratio * 1.5 = 1.5, plus recency 0.5 = 2.0 → just clears medium.
    expect(result.culprit?.confidence).toBe("medium");
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("touched 2 of 2 suspected files"),
      ])
    );
  });

  it("ignores files when no resolved files are provided", () => {
    const c = commit({
      sha: "c",
      message: "refactor: extract helper",
      touchedFiles: ["src/a.ts", "src/b.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([c], {
      affectedArea: "refactor",
      // No resolvedFiles
      now: NOW,
    });
    // Score only includes the area match + recency. No "touched X of Y"
    // reason chip.
    const fileReasons = result.culprit?.reasons.filter((r) =>
      r.includes("touched")
    );
    expect(fileReasons).toEqual([]);
  });

  it("does not award recency bonus for commits older than the window", () => {
    const old = commit({
      sha: "old",
      message: "fix: checkout payment retry race",
      date: "2026-01-01T00:00:00Z", // ~110 days ago — outside 7-day window
      touchedFiles: ["src/lib/checkout.ts"],
    });
    const result = detectLikelyCulprit([old], {
      affectedArea: "checkout payment retry",
      now: NOW,
    });
    // No "merged X days ago" reason.
    const recencyReasons = result.culprit?.reasons.filter((r) =>
      r.includes("merged")
    );
    expect(recencyReasons).toEqual([]);
  });

  it("formats recency as 'merged today' for sub-1-day age", () => {
    const fresh = commit({
      sha: "fresh",
      message: "fix: checkout payment retry",
      date: new Date(NOW.getTime() - 3600_000).toISOString(), // 1h ago
    });
    const result = detectLikelyCulprit([fresh], {
      affectedArea: "checkout payment retry",
      now: NOW,
    });
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining(["merged today"])
    );
  });

  it("formats recency as 'merged yesterday' for 1-2 day age", () => {
    const yesterday = commit({
      sha: "yest",
      message: "fix: checkout payment retry",
      date: new Date(NOW.getTime() - 86_400_000 - 1000).toISOString(),
    });
    const result = detectLikelyCulprit([yesterday], {
      affectedArea: "checkout payment retry",
      now: NOW,
    });
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining(["merged yesterday"])
    );
  });

  it("breaks score ties by date (newer first), then by SHA (lex)", () => {
    // Two commits with identical scores. Newer one wins.
    const older = commit({
      sha: "zzz",
      message: "fix: checkout",
      date: "2026-04-15T00:00:00Z",
    });
    const newer = commit({
      sha: "aaa",
      message: "fix: checkout",
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([older, newer], {
      affectedArea: "checkout",
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("aaa");

    // Identical date AND score → SHA tiebreaker.
    const a = commit({
      sha: "aaa",
      message: "fix: checkout",
      date: "2026-04-19T00:00:00Z",
    });
    const b = commit({
      sha: "bbb",
      message: "fix: checkout",
      date: "2026-04-19T00:00:00Z",
    });
    const result2 = detectLikelyCulprit([a, b], {
      affectedArea: "checkout",
      now: NOW,
    });
    expect(result2.culprit?.sha).toBe("aaa");
  });

  it("truncates long affectedArea text in reason chips", () => {
    const c = commit({
      sha: "c",
      message: "fix: payment race in checkout",
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([c], {
      affectedArea:
        "the checkout payment retry race condition that has been " +
        "haunting us for weeks now in the production environment",
      now: NOW,
    });
    const areaReason = result.culprit?.reasons.find((r) =>
      r.startsWith("matches affected area")
    );
    expect(areaReason).toBeDefined();
    expect(areaReason!.length).toBeLessThan(80);
    expect(areaReason).toContain("…");
  });

  it("reports topScore and runnerUpSha for observability even on null culprits", () => {
    // Two near-zero candidates → null culprit, but we still report stats.
    const a = commit({ sha: "noise-a", message: "chore: bump", date: "2026-04-19T00:00:00Z" });
    const b = commit({ sha: "noise-b", message: "chore: lint", date: "2026-04-15T00:00:00Z" });
    const result = detectLikelyCulprit([a, b], {
      affectedArea: "checkout",
      now: NOW,
    });
    expect(result.culprit).toBeNull();
    expect(result.topScore).toBeLessThan(2);
    expect(result.runnerUpSha).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// detectLikelyCulpritFromEnrichment()
// ---------------------------------------------------------------------------

describe("detectLikelyCulpritFromEnrichment", () => {
  function enrichment(
    overrides: Partial<RepoEnrichmentInput> = {}
  ): RepoEnrichmentInput {
    return {
      repoFullName: "octo/repo",
      ref: "deadbeef",
      ...overrides,
    };
  }

  it("returns null when there are no suspected regressions", () => {
    const result = detectLikelyCulpritFromEnrichment(enrichment(), {
      affectedArea: "checkout",
    });
    expect(result.culprit).toBeNull();
  });

  it("collects resolvedFiles from evidence + affectedArea + stack locations", () => {
    const winner = commit({
      sha: "winner",
      message: "fix: checkout retry",
      touchedFiles: [
        "src/lib/checkout.ts",
        "src/lib/payment.ts",
        "src/lib/affected.ts",
      ],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulpritFromEnrichment(
      enrichment({
        suspectedRegressions: [winner],
        affectedAreaLocation: { file: "src/lib/affected.ts" },
        stackLocations: [{ file: "src/lib/payment.ts", line: 10 }],
        evidenceLocations: {
          "ev-1": [{ file: "src/lib/checkout.ts", line: 42 }],
        },
      }),
      { affectedArea: "checkout retry", now: NOW }
    );
    // The commit touched all 3 resolved files → file ratio = 1.0 → +1.5.
    // Plus area match (2) + recency (0.5) = 4.0 → high confidence (no
    // runner-up, gap = Infinity).
    expect(result.culprit?.confidence).toBe("high");
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("touched 3 of 3 suspected files"),
      ])
    );
  });

  it("dedupes the same file appearing in multiple location buckets", () => {
    const c = commit({
      sha: "c",
      message: "refactor",
      touchedFiles: ["src/a.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulpritFromEnrichment(
      enrichment({
        suspectedRegressions: [c],
        affectedAreaLocation: { file: "src/a.ts" },
        stackLocations: [{ file: "src/a.ts", line: 1 }],
        evidenceLocations: { "ev-1": [{ file: "src/a.ts" }] },
      }),
      { affectedArea: "unrelated", now: NOW }
    );
    // If we didn't dedupe, resolvedFiles would be ['a','a','a'] and
    // commit's overlap of 1 / 3 = 0.33 ratio. With dedupe: 1/1 = 1.0.
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("touched 1 of 1 suspected file"),
      ])
    );
  });
});
