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
  classifyCommitKind,
  classifyCommitScopes,
  classifyFileScopes,
  detectLikelyCulprit,
  detectLikelyCulpritFromEnrichment,
  extractContradictionScopes,
  inferDiagnosisScopes,
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
    expect(result).toEqual({
      culprit: null,
      topScore: 0,
      runnerUpSha: null,
      topCandidateShas: [],
    });
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

  it("exposes topCandidateShas ordered by score for diff-aware reranking", () => {
    // Winner and runner-up with clearly different scores. The order
    // should be [winner, runner-up, ...].
    const winner = commit({
      sha: "winner",
      message: "fix: checkout submit",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const runnerUp = commit({
      sha: "runnerup",
      message: "refactor: checkout",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-18T00:00:00Z",
    });
    const noise = commit({
      sha: "noise",
      message: "chore: bump",
      date: "2026-04-17T00:00:00Z",
    });
    const result = detectLikelyCulprit([noise, runnerUp, winner], {
      affectedArea: "checkout submit",
      resolvedFiles: ["src/checkout.ts"],
      now: NOW,
    });
    expect(result.topCandidateShas[0]).toBe("winner");
    expect(result.topCandidateShas[1]).toBe("runnerup");
    expect(result.topCandidateShas).toContain("noise");
  });

  it("caps topCandidateShas at 5 to bound downstream fan-out", () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      commit({
        sha: `c${i}`,
        message: "fix: checkout",
        touchedFiles: ["src/checkout.ts"],
        date: `2026-04-${10 + i}T00:00:00Z`,
      })
    );
    const result = detectLikelyCulprit(commits, {
      affectedArea: "checkout",
      resolvedFiles: ["src/checkout.ts"],
      now: NOW,
    });
    expect(result.topCandidateShas.length).toBeLessThanOrEqual(5);
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

// ---------------------------------------------------------------------------
// Phase 2.8 — scope classification
// ---------------------------------------------------------------------------

describe("classifyFileScopes", () => {
  it("tags spec/test files as test", () => {
    expect(classifyFileScopes("src/foo.test.ts")).toContain("test");
    expect(classifyFileScopes("src/foo.spec.tsx")).toContain("test");
    expect(classifyFileScopes("src/__tests__/foo.ts")).toContain("test");
    expect(classifyFileScopes("tests/checkout.ts")).toContain("test");
    expect(classifyFileScopes("e2e/login.ts")).toContain("test");
    expect(classifyFileScopes("cypress/integration/x.ts")).toContain("test");
    expect(classifyFileScopes("src/Button.stories.tsx")).toContain("test");
  });

  it("does not misclassify a source file with 'test' in its name as test-only", () => {
    expect(classifyFileScopes("src/tester.ts")).not.toContain("test");
    expect(classifyFileScopes("src/testing-utils.ts")).not.toContain("test");
  });

  it("tags markdown / docs folders as docs", () => {
    expect(classifyFileScopes("README.md")).toContain("docs");
    expect(classifyFileScopes("docs/guide.mdx")).toContain("docs");
    expect(classifyFileScopes("CHANGELOG.md")).toContain("docs");
    expect(classifyFileScopes("CONTRIBUTING")).toContain("docs");
  });

  it("tags lockfiles, CI config, and tool configs as config", () => {
    expect(classifyFileScopes("package-lock.json")).toContain("config");
    expect(classifyFileScopes("yarn.lock")).toContain("config");
    expect(classifyFileScopes(".github/workflows/test.yml")).toContain("config");
    expect(classifyFileScopes(".eslintrc.json")).toContain("config");
    expect(classifyFileScopes("Dockerfile")).toContain("config");
    expect(classifyFileScopes(".gitignore")).toContain("config");
  });

  it("does NOT tag application package.json as config", () => {
    // package.json often holds real behaviour (deps, scripts) so a
    // change there isn't dismissible. package-lock.json is different.
    expect(classifyFileScopes("package.json")).not.toContain("config");
  });

  it("tags ios / android paths and platform-specific file types", () => {
    expect(classifyFileScopes("ios/Runner/AppDelegate.swift")).toContain("ios");
    expect(classifyFileScopes("src/App.swift")).toContain("ios");
    expect(classifyFileScopes("android/app/src/main/MainActivity.kt")).toContain("android");
    expect(classifyFileScopes("src/App.kt")).toContain("android");
  });

  it("tags frontend/backend via typical folder + filetype shapes", () => {
    expect(classifyFileScopes("src/components/Button.tsx")).toContain("frontend");
    expect(classifyFileScopes("src/styles/app.css")).toContain("frontend");
    expect(classifyFileScopes("server/routes/users.ts")).toContain("backend");
    expect(classifyFileScopes("api/v1/handler.py")).toContain("backend");
  });
});

describe("classifyCommitKind", () => {
  it("returns 'test' when all touched files are tests", () => {
    expect(
      classifyCommitKind([
        "src/foo.test.ts",
        "tests/checkout.spec.ts",
        "e2e/login.ts",
      ])
    ).toBe("test");
  });

  it("returns 'docs' when all touched files are docs", () => {
    expect(
      classifyCommitKind(["README.md", "docs/guide.mdx", "CHANGELOG.md"])
    ).toBe("docs");
  });

  it("returns 'config' when all touched files are tool/CI config", () => {
    expect(
      classifyCommitKind([
        "package-lock.json",
        ".github/workflows/ci.yml",
        ".eslintrc.json",
      ])
    ).toBe("config");
  });

  it("returns null for a mixed test + docs commit", () => {
    expect(
      classifyCommitKind(["src/foo.test.ts", "README.md"])
    ).toBeNull();
  });

  it("returns null when any file escapes the kind classification", () => {
    expect(
      classifyCommitKind(["src/foo.test.ts", "src/checkout.ts"])
    ).toBeNull();
  });

  it("returns null for the empty commit (defense — shouldn't happen, but)", () => {
    expect(classifyCommitKind([])).toBeNull();
  });
});

describe("classifyCommitScopes", () => {
  it("unions scopes from every touched file", () => {
    const scopes = classifyCommitScopes([
      "src/components/Button.tsx",
      "server/routes/users.ts",
    ]);
    expect(scopes.has("frontend")).toBe(true);
    expect(scopes.has("backend")).toBe(true);
  });

  it("returns an empty set for files that don't match any scope", () => {
    const scopes = classifyCommitScopes(["src/checkout.ts", "src/util.ts"]);
    expect(scopes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2.8 — contradiction extraction
// ---------------------------------------------------------------------------

describe("extractContradictionScopes", () => {
  it("flips 'iOS only' to exclude android", () => {
    const out = extractContradictionScopes(["Only reproduces on iOS"]);
    expect(out.has("android")).toBe(true);
    expect(out.has("ios")).toBe(false);
  });

  it("flips 'frontend only' to exclude backend", () => {
    const out = extractContradictionScopes(["Frontend only — no server-side involvement"]);
    expect(out.has("backend")).toBe(true);
    expect(out.has("frontend")).toBe(false);
  });

  it("recognises '<scope> only' variants", () => {
    const out1 = extractContradictionScopes(["iOS-only issue"]);
    expect(out1.has("android")).toBe(true);
    const out2 = extractContradictionScopes(["Happens backend-only"]);
    expect(out2.has("frontend")).toBe(true);
  });

  it("excludes directly with 'not X' patterns", () => {
    const out = extractContradictionScopes(["Not an Android issue"]);
    expect(out.has("android")).toBe(true);
    expect(out.has("ios")).toBe(false);
  });

  it("excludes with 'doesn't / no / never / isn't / without'", () => {
    expect(extractContradictionScopes(["Doesn't happen on iOS"]).has("ios")).toBe(true);
    expect(extractContradictionScopes(["No server-side involvement"]).has("backend")).toBe(true);
    expect(extractContradictionScopes(["Never on android"]).has("android")).toBe(true);
    expect(extractContradictionScopes(["Isn't a backend problem"]).has("backend")).toBe(true);
  });

  it("skips 'not only X' (ambiguous)", () => {
    const out = extractContradictionScopes(["Not only on iOS — Android also affected"]);
    expect(out.size).toBe(0);
  });

  it("merges multiple contradictions and returns the union", () => {
    const out = extractContradictionScopes([
      "Only on iOS",
      "Not a backend issue",
    ]);
    expect(out.has("android")).toBe(true);
    expect(out.has("backend")).toBe(true);
  });

  it("returns empty set for undefined / empty / irrelevant text", () => {
    expect(extractContradictionScopes(undefined).size).toBe(0);
    expect(extractContradictionScopes([]).size).toBe(0);
    expect(
      extractContradictionScopes([
        "The two logs describe failures at different frames.",
      ]).size
    ).toBe(0);
  });

  it("ignores unknown scope vocabulary (no false exclusions)", () => {
    const out = extractContradictionScopes([
      "Only on Wednesdays", // not a scope we know
    ]);
    expect(out.size).toBe(0);
  });
});

describe("inferDiagnosisScopes", () => {
  it("identifies test-scoped diagnosis from common phrasings", () => {
    expect(inferDiagnosisScopes(["the test suite is flaky"]).has("test")).toBe(true);
    expect(inferDiagnosisScopes(["specs are failing intermittently"]).has("test")).toBe(true);
  });

  it("identifies docs/config/platform scopes", () => {
    expect(inferDiagnosisScopes(["README is outdated"]).has("docs")).toBe(true);
    expect(inferDiagnosisScopes(["dependency upgrade broke the build"]).has("config")).toBe(true);
    expect(inferDiagnosisScopes(["iPhone users report the issue"]).has("ios")).toBe(true);
    expect(inferDiagnosisScopes(["backend 500 errors"]).has("backend")).toBe(true);
  });

  it("returns empty set for unrelated / empty text", () => {
    expect(inferDiagnosisScopes(["checkout flow crash"]).size).toBe(0);
    expect(inferDiagnosisScopes([undefined]).size).toBe(0);
    expect(inferDiagnosisScopes([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2.8 — penalty application inside detectLikelyCulprit
// ---------------------------------------------------------------------------

describe("detectLikelyCulprit — negative evidence", () => {
  it("demotes a test-only commit that would otherwise be the pick", () => {
    // A commit that (a) matches the affected area + touched the only
    // suspected file, but (b) consists exclusively of test files. It
    // raw-scores high but should be capped at medium + carry a negative
    // reason chip.
    const testOnly = commit({
      sha: "tests-only",
      message: "fix: checkout retry flow tests",
      touchedFiles: [
        "src/checkout.test.ts",
        "src/retry.spec.ts",
        "tests/e2e/checkout.ts",
      ],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([testOnly], {
      affectedArea: "checkout retry flow",
      resolvedFiles: ["src/checkout.test.ts"],
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("tests-only");
    // Confidence capped at medium, even if raw score was high.
    expect(result.culprit?.confidence).toBe("medium");
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("but all touched files are tests"),
      ])
    );
  });

  it("does NOT demote a test-only commit when the diagnosis IS about tests", () => {
    const testOnly = commit({
      sha: "tests-only",
      message: "fix: checkout retry flow tests",
      touchedFiles: ["src/checkout.test.ts", "src/retry.spec.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([testOnly], {
      // Diagnosis is explicitly about the test suite flaking — test-only
      // commits are legitimate candidates, not false positives.
      affectedArea: "the checkout test suite is flaky",
      resolvedFiles: ["src/checkout.test.ts"],
      now: NOW,
    });
    expect(
      result.culprit?.reasons.some((r) =>
        r.includes("but all touched files are tests")
      )
    ).toBe(false);
  });

  it("demotes a docs-only commit", () => {
    const docs = commit({
      sha: "docs-only",
      message: "docs: explain checkout retry flow",
      touchedFiles: ["README.md", "docs/checkout.md"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([docs], {
      affectedArea: "checkout retry flow",
      now: NOW,
    });
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("but all touched files are docs"),
      ])
    );
    expect(result.culprit?.confidence).toBe("medium");
  });

  it("demotes a config-only commit", () => {
    const cfg = commit({
      sha: "cfg-only",
      message: "chore: bump dependency versions in checkout",
      touchedFiles: ["package-lock.json", ".github/workflows/ci.yml"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([cfg], {
      affectedArea: "checkout",
      now: NOW,
    });
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("but all touched files are config"),
      ])
    );
  });

  it("does NOT demote a mixed test + code commit", () => {
    // Real fixes often land with a matching test. Those should not be
    // demoted — the test file alone is the red flag.
    const mixed = commit({
      sha: "mixed",
      message: "fix: checkout retry race",
      touchedFiles: ["src/checkout.ts", "src/checkout.test.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([mixed], {
      affectedArea: "checkout retry race",
      now: NOW,
    });
    expect(
      result.culprit?.reasons.every(
        (r) => !r.startsWith("but all touched files are")
      )
    ).toBe(true);
  });

  it("demotes when a contradiction says 'iOS only' and the commit is android-only", () => {
    const androidCommit = commit({
      sha: "android",
      message: "fix: handle null in checkout flow",
      touchedFiles: [
        "android/app/src/main/java/Checkout.kt",
        "android/app/build.gradle",
      ],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([androidCommit], {
      affectedArea: "checkout flow",
      contradictions: ["Only reproduces on iOS"],
      now: NOW,
    });
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("but contradicts scope"),
      ])
    );
    expect(result.culprit?.confidence).toBe("medium");
  });

  it("does NOT demote a commit straddling included + excluded scopes", () => {
    // A commit that touched BOTH ios/ and android/ isn't cleanly in the
    // excluded scope — we only penalise when every file is in the
    // excluded set.
    const mixedPlatform = commit({
      sha: "mixed-plat",
      message: "fix: checkout flow",
      touchedFiles: [
        "ios/Runner/Checkout.swift",
        "android/app/src/main/Checkout.kt",
      ],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([mixedPlatform], {
      affectedArea: "checkout flow",
      contradictions: ["Only on iOS"],
      now: NOW,
    });
    expect(
      result.culprit?.reasons.every(
        (r) => !r.startsWith("but contradicts")
      )
    ).toBe(true);
  });

  it("promotes a clean commit over a demoted one with higher raw signal", () => {
    // Raw scores favour the test-only commit (stronger keyword overlap).
    // After demotion, the clean commit should win.
    const demoted = commit({
      sha: "demoted",
      message: "fix: checkout retry flow race tests tests tests",
      touchedFiles: [
        "src/checkout.test.ts",
        "src/retry.spec.ts",
        "tests/e2e/checkout.ts",
      ],
      date: "2026-04-19T00:00:00Z",
    });
    const clean = commit({
      sha: "clean",
      message: "fix: checkout retry",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([demoted, clean], {
      affectedArea: "checkout retry flow",
      resolvedFiles: ["src/checkout.ts"],
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("clean");
  });

  it("caps high confidence at medium when the picked commit is penalised", () => {
    // Strong raw signal: area match + root cause + 1/1 file hit +
    // recency → normally enough for "high". But the commit is docs-only.
    const docs = commit({
      sha: "docs",
      message: "docs: document checkout retry race condition",
      touchedFiles: ["docs/checkout.md"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([docs], {
      affectedArea: "checkout retry race",
      probableRootCause: "race condition in checkout",
      resolvedFiles: ["docs/checkout.md"],
      now: NOW,
    });
    expect(result.culprit?.confidence).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// Phase 2.9 — diff-aware signal
// ---------------------------------------------------------------------------

describe("detectLikelyCulprit — diff-aware signal", () => {
  it("awards bonus + reason when a commit's diff touches a stack-frame line", () => {
    const target = commit({
      sha: "target",
      message: "fix: checkout",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    // Probe returns true for line 42 on the resolved file — simulates
    // the diff hunk covering that line.
    // Phase 2.9.1: probes return distance (null | number). `0` = exact
    // hit (what this test exercises); anything >0 would be a near-hit.
    const probe = (file: string, line: number): number | null =>
      file === "src/checkout.ts" && line === 42 ? 0 : null;

    const result = detectLikelyCulprit([target], {
      affectedArea: "checkout",
      resolvedFiles: ["src/checkout.ts"],
      stackLines: [{ file: "src/checkout.ts", line: 42 }],
      diffProbesBySha: new Map([["target", probe]]),
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("target");
    expect(result.culprit?.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("diff touches src/checkout.ts:42"),
      ])
    );
  });

  it("flips the pick when the runner-up's diff hits a stack line and leader's doesn't", () => {
    // Both commits touch the same file + match the area. Leader has
    // slightly more recency, but runner-up's diff is the one that
    // actually modifies the crashing line. The diff signal should
    // promote the runner-up to top.
    const leader = commit({
      sha: "leader",
      message: "refactor: checkout flow",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T12:00:00Z", // 0.5 days ago
    });
    const truth = commit({
      sha: "truth",
      message: "fix: checkout",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-17T00:00:00Z", // 3 days ago
    });
    // Only truth's diff touches line 42.
    const probes = new Map<
      string,
      (f: string, l: number) => number | null
    >([
      // Phase 2.9.1: null = no info; 0 = exact hit.
      ["leader", () => null],
      [
        "truth",
        (f, l) => (f === "src/checkout.ts" && l === 42 ? 0 : null),
      ],
    ]);

    const result = detectLikelyCulprit([leader, truth], {
      affectedArea: "checkout flow",
      resolvedFiles: ["src/checkout.ts"],
      stackLines: [{ file: "src/checkout.ts", line: 42 }],
      diffProbesBySha: probes,
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("truth");
  });

  it("no-ops when no diff probes are supplied (Phase <2.9 behaviour preserved)", () => {
    const c = commit({
      sha: "x",
      message: "fix: checkout",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout",
      resolvedFiles: ["src/checkout.ts"],
      stackLines: [{ file: "src/checkout.ts", line: 42 }],
      // No diffProbesBySha → diff signal inactive.
      now: NOW,
    });
    expect(
      result.culprit?.reasons.every((r) => !r.includes("diff touches"))
    ).toBe(true);
  });

  it("ignores stack lines with non-finite or non-positive line numbers", () => {
    // Defense: the resolver occasionally produces stack locations
    // without a usable line (path-only entries). Those must not
    // trigger false bonuses.
    const c = commit({
      sha: "x",
      message: "fix",
      touchedFiles: ["src/a.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    // Probe that claims "exact hit everywhere" — if invalid lines
    // reach it, we'd incorrectly credit the bonus.
    const probe = () => 0;
    const result = detectLikelyCulprit([c], {
      affectedArea: "irrelevant",
      stackLines: [
        { file: "src/a.ts", line: 0 },
        { file: "src/a.ts", line: -1 },
        { file: "src/a.ts", line: Number.NaN },
      ],
      diffProbesBySha: new Map([["x", probe]]),
      now: NOW,
    });
    expect(
      result.culprit === null ||
        result.culprit.reasons.every((r) => !r.includes("diff touches"))
    ).toBe(true);
  });

  it("credits only one bonus per commit even when multiple stack lines hit", () => {
    const c = commit({
      sha: "x",
      message: "fix: checkout",
      touchedFiles: ["src/a.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const probe = () => 0; // every line is an exact hit
    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout",
      stackLines: [
        { file: "src/a.ts", line: 10 },
        { file: "src/a.ts", line: 20 },
        { file: "src/a.ts", line: 30 },
      ],
      diffProbesBySha: new Map([["x", probe]]),
      now: NOW,
    });
    const diffReasons =
      result.culprit?.reasons.filter((r) => r.includes("diff touches")) ?? [];
    // Only one "diff touches" reason — the scorer must not emit three.
    expect(diffReasons.length).toBe(1);
    // And it should name the FIRST hit for determinism.
    expect(diffReasons[0]).toContain("src/a.ts:10");
  });

  it("commits without a probe entry are unaffected by diff signal", () => {
    const probed = commit({
      sha: "probed",
      message: "fix: checkout",
      touchedFiles: ["src/a.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const unprobed = commit({
      sha: "unprobed",
      message: "fix: checkout",
      touchedFiles: ["src/a.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const probes = new Map<
      string,
      (f: string, l: number) => number | null
    >([["probed", () => 0]]);
    const result = detectLikelyCulprit([probed, unprobed], {
      affectedArea: "checkout",
      stackLines: [{ file: "src/a.ts", line: 42 }],
      diffProbesBySha: probes,
      now: NOW,
    });
    // Probed wins because of the diff bonus — unprobed has identical
    // raw signal minus the 2-point hit bonus.
    expect(result.culprit?.sha).toBe("probed");
  });
});

// ---------------------------------------------------------------------------
// Phase 2.9.1 — line proximity
// ---------------------------------------------------------------------------

describe("detectLikelyCulprit — diff-aware proximity (Phase 2.9.1)", () => {
  it("awards smaller near-hit bonus + ±N reason for distances inside the window", () => {
    const c = commit({
      sha: "near",
      message: "fix: checkout",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    // Probe returns distance 3 — not an exact hit but inside the
    // near window (DIFF_LINE_NEAR_WINDOW = 10).
    const probe = (file: string, line: number): number | null =>
      file === "src/checkout.ts" && line === 42 ? 3 : null;

    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout",
      resolvedFiles: ["src/checkout.ts"],
      stackLines: [{ file: "src/checkout.ts", line: 42 }],
      diffProbesBySha: new Map([["near", probe]]),
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("near");
    // Reason must carry the ±distance so receivers know it's not an
    // exact hit. Prefix still "diff touches " so renderer ordering
    // treats it the same way (high-priority positive signal).
    expect(
      result.culprit?.reasons.some((r) =>
        r.includes("diff touches src/checkout.ts:42 (stack frame, ±3 lines)")
      )
    ).toBe(true);
  });

  it("exact hit strictly outscores near hit when both are available", () => {
    // Exact-hit commit and near-hit commit have identical keyword /
    // file / recency signals. The exact-hit commit must win.
    const exact = commit({
      sha: "exact",
      message: "fix: checkout",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const near = commit({
      sha: "near",
      message: "fix: checkout",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const probes = new Map<
      string,
      (f: string, l: number) => number | null
    >([
      ["exact", () => 0],
      ["near", () => 5],
    ]);
    const result = detectLikelyCulprit([exact, near], {
      affectedArea: "checkout",
      resolvedFiles: ["src/checkout.ts"],
      stackLines: [{ file: "src/checkout.ts", line: 42 }],
      diffProbesBySha: probes,
      now: NOW,
    });
    expect(result.culprit?.sha).toBe("exact");
  });

  it("no credit for distances outside the near window", () => {
    const c = commit({
      sha: "far",
      message: "fix: checkout",
      touchedFiles: ["src/checkout.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    // Distance 50 — nowhere near the stack frame. Should not credit.
    const probe = (): number | null => 50;
    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout",
      resolvedFiles: ["src/checkout.ts"],
      stackLines: [{ file: "src/checkout.ts", line: 42 }],
      diffProbesBySha: new Map([["far", probe]]),
      now: NOW,
    });
    expect(
      result.culprit?.reasons.every((r) => !r.includes("diff touches"))
    ).toBe(true);
  });

  it("picks the best (smallest-distance) stack line for the reason", () => {
    // Commit's diff is near stack line A by 7 lines and near stack
    // line B by 2 lines. The reason must cite B (the closer match).
    // Message echoes area so the commit clears MIN_SCORE_MEDIUM
    // with room to spare — we want this test to assert on reason
    // PHRASING, not threshold behaviour.
    const c = commit({
      sha: "x",
      message: "fix: checkout",
      touchedFiles: ["src/a.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const probe = (_file: string, line: number): number | null => {
      if (line === 100) return 7;
      if (line === 200) return 2;
      return null;
    };
    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout",
      stackLines: [
        { file: "src/a.ts", line: 100 },
        { file: "src/a.ts", line: 200 },
      ],
      diffProbesBySha: new Map([["x", probe]]),
      now: NOW,
    });
    // Smaller distance wins — we cite line 200 with ±2.
    expect(
      result.culprit?.reasons.some((r) =>
        r.includes("src/a.ts:200 (stack frame, ±2 lines)")
      )
    ).toBe(true);
    expect(
      result.culprit?.reasons.every(
        (r) => !r.includes("src/a.ts:100")
      )
    ).toBe(true);
  });

  it("distance 0 via any line short-circuits and uses 'exact' phrasing", () => {
    // One line is an exact hit, another is merely near. The exact
    // hit must win and the reason must NOT carry the ±distance
    // suffix (it's a plain exact touch).
    const c = commit({
      sha: "x",
      message: "fix: checkout",
      touchedFiles: ["src/a.ts"],
      date: "2026-04-19T00:00:00Z",
    });
    const probe = (_file: string, line: number): number | null => {
      if (line === 100) return 4; // near
      if (line === 200) return 0; // exact
      return null;
    };
    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout",
      stackLines: [
        { file: "src/a.ts", line: 100 },
        { file: "src/a.ts", line: 200 },
      ],
      diffProbesBySha: new Map([["x", probe]]),
      now: NOW,
    });
    const reasons = result.culprit?.reasons ?? [];
    expect(reasons.some((r) => r.includes("src/a.ts:200 (stack frame)"))).toBe(
      true
    );
    // No ±N suffix when we landed on an exact hit.
    expect(reasons.every((r) => !r.includes("±"))).toBe(true);
  });

  it("a pure near-hit alone can't push a weak commit past MIN_SCORE_MEDIUM", () => {
    // A commit with NOTHING else going for it — no keyword overlap,
    // no recency, no file hits — should not be surfaced on near-hit
    // alone. W_DIFF_LINE_NEAR = 1 which is below MIN_SCORE_MEDIUM.
    const c = commit({
      sha: "weak",
      message: "chore: bump deps",
      touchedFiles: [],
      date: "2020-01-01T00:00:00Z", // old; no recency bonus
    });
    const probe = (): number | null => 5; // near hit
    const result = detectLikelyCulprit([c], {
      affectedArea: "checkout",
      stackLines: [{ file: "src/a.ts", line: 10 }],
      diffProbesBySha: new Map([["weak", probe]]),
      now: NOW,
    });
    expect(result.culprit).toBeNull();
  });
});
