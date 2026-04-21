/**
 * Phase 2.8.1 — culprit-scoring bakeoff.
 *
 * The existing `evals/golden/cases/` fixtures are analysis-pipeline evals
 * (evidence in → diagnosis out). They don't carry ground-truth culprit
 * commits or regression windows, so they can't directly exercise
 * `detectLikelyCulprit`.
 *
 * This file is a focused, table-driven bakeoff that mirrors the golden
 * categories (obvious_bug, contradiction, insufficient_evidence,
 * false_lead, multi_step_regression, risky_handoff) with synthetic
 * commit histories and asserts on:
 *   - the picked SHA (or null),
 *   - the confidence band,
 *   - presence of expected reason substrings (positive + negative).
 *
 * Runs as a regular vitest suite. When the scorer thresholds/weights
 * are tuned, changes to these expectations signal a real behavioural
 * shift — update them intentionally, with a commit message that
 * explains what shifted.
 *
 * Determinism: every case supplies an explicit `now` and explicit
 * dates, so tie-break order is reproducible.
 */

import { describe, expect, it } from "vitest";

import {
  detectLikelyCulprit,
  type CulpritSignals,
} from "./culprit-detection";
import type { CommitRef } from "./packet";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/// Fixed "now" so recency bonuses are reproducible. Picked to leave a
/// comfortable margin from the real calendar so dates "2 days ago" below
/// really are inside the 7-day culprit recency window.
const NOW = new Date("2026-04-20T00:00:00Z");

/// Day-offset helper — `dAgo(2)` returns an ISO string 2 days before NOW.
function dAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function commit(partial: Partial<CommitRef> & Pick<CommitRef, "sha" | "message" | "date">): CommitRef {
  return {
    author: "dev",
    url: `https://github.com/acme/checkout/commit/${partial.sha}`,
    touchedFiles: [],
    ...partial,
  };
}

type BakeoffCase = {
  id: string;
  category: string;
  signals: CulpritSignals;
  regressions: CommitRef[];
  expected: {
    /// `null` → scorer should return `{ culprit: null }`.
    /// Otherwise the SHA of the expected pick.
    sha: string | null;
    confidence?: "high" | "medium";
    /// Each string must appear as a substring in at least one reason
    /// bullet on the picked culprit. Use this to lock in positive AND
    /// negative reasoning the scorer should surface.
    reasonIncludes?: string[];
    /// Strings that must NOT appear in any reason bullet. Use to guard
    /// against false-positive chips (e.g. "matches affected area" on a
    /// commit whose message is unrelated).
    reasonExcludes?: string[];
  };
};

// ---------------------------------------------------------------------------
// Bakeoff cases
// ---------------------------------------------------------------------------

const CASES: BakeoffCase[] = [
  // -------------------------------------------------------------------------
  // 1. obvious_bug — clean single-commit match. Should be a confident pick.
  // -------------------------------------------------------------------------
  {
    id: "obvious_bug_single_match",
    category: "obvious_bug",
    signals: {
      affectedArea: "checkout API submit boundary",
      probableRootCause: "unhandled payment failure in submitCheckout",
      summary: "Checkout fails consistently after submit.",
      resolvedFiles: ["src/lib/checkout.ts"],
      now: NOW,
    },
    regressions: [
      commit({
        sha: "obvious01",
        message: "fix: handle payment failure in submitCheckout",
        date: dAgo(1),
        touchedFiles: ["src/lib/checkout.ts"],
      }),
      commit({
        sha: "noise-unrelated",
        message: "chore: update dependencies",
        date: dAgo(4),
        touchedFiles: ["package.json"],
      }),
    ],
    expected: {
      sha: "obvious01",
      confidence: "high",
      reasonIncludes: [
        "matches affected area",
        "touched 1 of 1 suspected file",
      ],
    },
  },

  // -------------------------------------------------------------------------
  // 2. contradiction — "iOS only" + android-only commit → demote.
  //    Match strongly on keywords but fire scope penalty.
  // -------------------------------------------------------------------------
  {
    id: "contradiction_scope_mismatch",
    category: "contradiction",
    signals: {
      affectedArea: "checkout flow null handler",
      probableRootCause: "missing null guard in checkout",
      contradictions: ["Only reproduces on iOS — Android users unaffected"],
      resolvedFiles: ["android/app/src/main/Checkout.kt"],
      now: NOW,
    },
    regressions: [
      commit({
        sha: "android01",
        message: "fix: null guard in checkout flow handler",
        date: dAgo(1),
        touchedFiles: ["android/app/src/main/Checkout.kt"],
      }),
    ],
    expected: {
      sha: "android01",
      // Strong raw signal but scope penalty caps at medium — the
      // human-facing chip must be "Possible", not "Likely".
      confidence: "medium",
      reasonIncludes: ["but contradicts scope"],
    },
  },

  // -------------------------------------------------------------------------
  // 3. insufficient_evidence — vague/empty signals + stale commits.
  //    The scorer should refuse to guess.
  // -------------------------------------------------------------------------
  {
    id: "insufficient_evidence_refuses_to_guess",
    category: "insufficient_evidence",
    signals: {
      // Empty area / cause — the LLM bailed out. Only a vague summary
      // is present. No resolved files (path-only evidence).
      summary: "something broke somewhere",
      resolvedFiles: [],
      now: NOW,
    },
    regressions: [
      commit({
        sha: "stale01",
        message: "chore: tidy imports",
        date: dAgo(25), // inside 30d regression window, outside culprit
        touchedFiles: ["src/utils.ts"],
      }),
      commit({
        sha: "stale02",
        message: "docs: update README",
        date: dAgo(20),
        touchedFiles: ["README.md"],
      }),
    ],
    expected: {
      sha: null, // no candidate clears the medium threshold → no chip
    },
  },

  // -------------------------------------------------------------------------
  // 4. false_lead — multiple plausible commits, no runaway winner.
  //    The scorer may pick one but MUST NOT label it "high".
  // -------------------------------------------------------------------------
  {
    id: "false_lead_no_runaway_winner",
    category: "false_lead",
    signals: {
      affectedArea: "cache invalidation timing",
      probableRootCause: "stale cache hint after background refresh",
      resolvedFiles: ["src/lib/cache.ts"],
      now: NOW,
    },
    regressions: [
      // Both commits mention "cache" (1-token area overlap) + "refresh"
      // (1-token cause overlap) + touch the resolved file + are inside
      // the recency window. Their raw scores should be near-tied so
      // the gap-to-runner-up is below MIN_GAP_HIGH, keeping the
      // confidence at medium regardless of which one wins.
      commit({
        sha: "cache01",
        message: "refactor: cache refresh logic",
        date: dAgo(3),
        touchedFiles: ["src/lib/cache.ts"],
      }),
      commit({
        sha: "cache02",
        message: "tweak: cache refresh handler",
        date: dAgo(2),
        touchedFiles: ["src/lib/cache.ts"],
      }),
    ],
    expected: {
      // Tie-broken by score (equal) → date (newer first) → cache02.
      // Key assertion: confidence must be medium, not high.
      sha: "cache02",
      confidence: "medium",
    },
  },

  // -------------------------------------------------------------------------
  // 5. multi_step_regression — multiple recent commits, one clearly
  //    strongest (touches the resolved file AND matches affected area).
  // -------------------------------------------------------------------------
  {
    id: "multi_step_regression_clear_leader",
    category: "multi_step_regression",
    signals: {
      affectedArea: "checkout submit regression",
      probableRootCause: "regression introduced in checkout validation",
      resolvedFiles: ["src/lib/checkout.ts"],
      now: NOW,
    },
    regressions: [
      // Leader: matches area + touches resolved file + recent.
      commit({
        sha: "leader01",
        message: "refactor: checkout validation regression",
        date: dAgo(2),
        touchedFiles: ["src/lib/checkout.ts"],
      }),
      // Runner-up: touches resolved file but message doesn't match.
      commit({
        sha: "runner01",
        message: "chore: rename variable in checkout",
        date: dAgo(4),
        touchedFiles: ["src/lib/checkout.ts"],
      }),
      // Noise: area match but wrong file.
      commit({
        sha: "noise01",
        message: "feat: checkout submit telemetry",
        date: dAgo(3),
        touchedFiles: ["src/lib/telemetry.ts"],
      }),
    ],
    expected: {
      sha: "leader01",
      // High IF the leader clears MIN_SCORE_HIGH and the gap to
      // runner-up is wide enough. With 2 area matches + 1 cause match
      // + 1/1 file-hit ratio + recency, this should hit "high".
      confidence: "high",
      reasonIncludes: ["matches affected area"],
    },
  },

  // -------------------------------------------------------------------------
  // 6. risky_handoff — high-severity signal but test-only commit.
  //    Scorer should surface it (strong signal) BUT demote to medium.
  // -------------------------------------------------------------------------
  {
    id: "risky_handoff_test_only_demote",
    category: "risky_handoff",
    signals: {
      affectedArea: "checkout submit critical path",
      probableRootCause: "race condition in checkout retry",
      resolvedFiles: ["src/lib/checkout.ts"],
      now: NOW,
    },
    regressions: [
      commit({
        sha: "testonly01",
        message: "test: cover checkout submit retry race",
        date: dAgo(1),
        // Notional mapping via resolver: commit's aggregated file is
        // the test file, not the source file. Scorer classifies as
        // test-only.
        touchedFiles: ["src/lib/checkout.test.ts"],
      }),
    ],
    expected: {
      sha: "testonly01",
      // Strong raw (area + recency), but penalty caps at medium.
      confidence: "medium",
      reasonIncludes: ["but all touched files are tests"],
    },
  },

  // -------------------------------------------------------------------------
  // 7. noise floor — many unrelated commits, nothing matches.
  //    Scorer must not invent a pick.
  // -------------------------------------------------------------------------
  {
    id: "noise_floor_no_pick",
    category: "false_lead",
    signals: {
      affectedArea: "authentication session refresh",
      probableRootCause: "token rotation race",
      resolvedFiles: ["src/lib/auth.ts"],
      now: NOW,
    },
    regressions: [
      commit({
        sha: "unrel01",
        message: "chore: bump eslint-plugin-react",
        date: dAgo(2),
        touchedFiles: ["package.json"],
      }),
      commit({
        sha: "unrel02",
        message: "docs: update contributing guide",
        date: dAgo(3),
        touchedFiles: ["CONTRIBUTING.md"],
      }),
      commit({
        sha: "unrel03",
        message: "ci: pin node version",
        date: dAgo(4),
        touchedFiles: [".github/workflows/ci.yml"],
      }),
    ],
    expected: {
      sha: null,
    },
  },
];

// ---------------------------------------------------------------------------
// Data-driven test harness
// ---------------------------------------------------------------------------

describe("phase 2.8.1 — culprit scorer bakeoff", () => {
  for (const c of CASES) {
    it(`[${c.category}] ${c.id}`, () => {
      const result = detectLikelyCulprit(c.regressions, c.signals);

      if (c.expected.sha === null) {
        expect(
          result.culprit,
          `expected no pick for ${c.id} but got ${result.culprit?.sha}`
        ).toBeNull();
        return;
      }

      expect(
        result.culprit,
        `expected a culprit for ${c.id} but got null (topScore=${result.topScore})`
      ).not.toBeNull();
      expect(result.culprit?.sha).toBe(c.expected.sha);

      if (c.expected.confidence) {
        expect(result.culprit?.confidence).toBe(c.expected.confidence);
      }

      if (c.expected.reasonIncludes) {
        const reasons = result.culprit?.reasons ?? [];
        for (const needle of c.expected.reasonIncludes) {
          expect(
            reasons.some((r) => r.includes(needle)),
            `expected reason containing "${needle}" in [${reasons.join(" | ")}]`
          ).toBe(true);
        }
      }

      if (c.expected.reasonExcludes) {
        const reasons = result.culprit?.reasons ?? [];
        for (const needle of c.expected.reasonExcludes) {
          expect(
            reasons.every((r) => !r.includes(needle)),
            `unexpected reason containing "${needle}" in [${reasons.join(" | ")}]`
          ).toBe(true);
        }
      }
    });
  }

  // Meta-assertion: the bakeoff must cover all six golden categories
  // so additions to the golden catalogue get reflected here.
  it("covers every golden category at least once", () => {
    const covered = new Set(CASES.map((c) => c.category));
    expect(covered).toContain("obvious_bug");
    expect(covered).toContain("contradiction");
    expect(covered).toContain("insufficient_evidence");
    expect(covered).toContain("false_lead");
    expect(covered).toContain("multi_step_regression");
    expect(covered).toContain("risky_handoff");
  });
});
