/**
 * Likely-culprit detection (Phase 2.7).
 *
 * Pure adapter that picks the most-likely-regression-causing commit from a
 * `RepoEnrichmentInput.suspectedRegressions` list, by cross-referencing the
 * LLM's signals (`affectedArea`, `probableRootCause`, optionally `summary`)
 * against each commit's `message` + `touchedFiles`.
 *
 * Why this layer exists at all:
 *
 *   The Phase 2.5 ranking is "which commits *are* candidates" — file hits
 *   and recency. That gives us up to 5 plausible regressions, but the
 *   receiver still has to read each one and guess which is the actual
 *   culprit. Phase 2.7 promotes the standout to a single chip rendered at
 *   the top of the packet, with an audit trail (`reasons`) so the receiver
 *   can second-guess our heuristic.
 *
 * Design decisions:
 *
 *   - **Scoring is additive, not multiplicative.** Each signal contributes
 *     a small score; we want a commit that hits 2 weak signals to outrank
 *     one that hits 1 strong signal. Multiplicative would let a single
 *     missing signal zero-out the whole score.
 *
 *   - **Confidence bands are gap-aware.** "high" requires both a clear
 *     absolute score AND a clear gap to runner-up — otherwise the chip
 *     would feel certain when the underlying signal is just two
 *     near-tied candidates.
 *
 *   - **Below medium, we emit nothing.** A confident-looking chip on a
 *     low-confidence guess is worse than no chip — it actively misleads.
 *     The renderer never sees a "low" culprit.
 *
 *   - **Pure & deterministic.** Same inputs → same output. No I/O. Sort
 *     ties by SHA so test snapshots are stable.
 */

import type {
  CommitRef,
  LikelyCulprit,
  RepoEnrichmentInput,
} from "@/lib/handoff/packet";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// Minimum score for a candidate to be surfaced as "medium" confidence.
/// Below this, the whole `likelyCulprit` field is omitted.
const MIN_SCORE_MEDIUM = 2;

/// Minimum score for a candidate to be surfaced as "high" confidence.
/// Additionally requires a `MIN_GAP_HIGH`-point gap to the runner-up so a
/// near-tie never claims certainty.
const MIN_SCORE_HIGH = 4;

/// Minimum score gap between #1 and #2 for high confidence.
const MIN_GAP_HIGH = 1.5;

/// Minimum keyword length considered. Shorter tokens are usually noise
/// ("a", "is", "if"). Matches the 3-char floor used elsewhere in TARG.
const MIN_KEYWORD_LENGTH = 3;

/// English + code stopwords that pollute keyword overlap. Kept small;
/// stripping too aggressively would lose domain words like "service".
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "for",
  "from",
  "with",
  "without",
  "into",
  "out",
  "in",
  "on",
  "at",
  "to",
  "of",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "by",
  "as",
  "if",
  "then",
  "else",
  "when",
  "while",
  "fix",
  "fixes",
  "fixed",
  "fixing",
  "bug",
  "issue",
  "patch",
  "update",
  "updates",
  "updated",
  "merge",
  "pull",
  "request",
  "pr",
]);

/// How many days back from `now` we count "recently merged" as a positive
/// signal. Outside this window, recency contributes 0.
const RECENT_MERGE_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CulpritSignals = {
  /// LLM-derived "affected area" string from the diagnosis. Strongest
  /// signal — this is the LLM's best guess at where the bug lives.
  affectedArea?: string;
  /// LLM-derived probable root cause. Slightly weaker than affectedArea
  /// (more speculative) but adds keyword coverage.
  probableRootCause?: string;
  /// Diagnosis summary. Weakest signal — broad context. Optional; if
  /// supplied we use it for keyword extraction only, not for the
  /// matched-keyword "reasons" chip text.
  summary?: string;
  /// Files the enrichment layer flagged as relevant (resolved evidence
  /// locations + affected-area location). Used to compute "touched X of Y
  /// suspected files" — independent from the regression's own
  /// `touchedFiles` (which is the commit's view).
  resolvedFiles?: string[];
  /// Clock override for the recency signal. Defaults to `new Date()`.
  now?: Date;
};

export type CulpritDetectionResult = {
  /// `null` when no candidate cleared the medium threshold. Distinct from
  /// "no candidates at all" — receivers can log this to detect over-strict
  /// thresholds without conflating with empty regression lists.
  culprit: LikelyCulprit | null;
  /// Score of the picked culprit (or top candidate even if it didn't
  /// clear the threshold), for observability/logging.
  topScore: number;
  /// SHA of the runner-up, for observability/logging. `null` when there
  /// are < 2 candidates.
  runnerUpSha: string | null;
};

/// Picks the most-likely culprit from the regressions list, scored against
/// the diagnosis signals. Returns `{ culprit: null }` when no candidate
/// clears the medium threshold.
///
/// Ranking is deterministic: ties on score are broken by SHA (lexical),
/// then by date (newer first), so test snapshots don't flap.
export function detectLikelyCulprit(
  regressions: CommitRef[],
  signals: CulpritSignals
): CulpritDetectionResult {
  if (regressions.length === 0) {
    return { culprit: null, topScore: 0, runnerUpSha: null };
  }

  const areaTokens = tokenize(signals.affectedArea);
  const causeTokens = tokenize(signals.probableRootCause);
  const summaryTokens = tokenize(signals.summary);
  const resolvedFiles = signals.resolvedFiles ?? [];
  const now = signals.now ?? new Date();

  const scored = regressions.map((commit) =>
    scoreCommit(commit, {
      areaTokens,
      causeTokens,
      summaryTokens,
      areaText: signals.affectedArea,
      causeText: signals.probableRootCause,
      resolvedFiles,
      now,
    })
  );

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Newer first on ties. Date.parse on bad input → NaN → ts comparisons
    // are false → falls through to SHA tiebreaker (still deterministic).
    const dateDiff =
      Date.parse(b.commit.date) - Date.parse(a.commit.date);
    if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
    return a.commit.sha.localeCompare(b.commit.sha);
  });

  const top = scored[0];
  const runnerUp = scored[1];
  const gap = runnerUp ? top.score - runnerUp.score : Infinity;

  if (top.score < MIN_SCORE_MEDIUM) {
    return {
      culprit: null,
      topScore: top.score,
      runnerUpSha: runnerUp?.commit.sha ?? null,
    };
  }

  const confidence: LikelyCulprit["confidence"] =
    top.score >= MIN_SCORE_HIGH && gap >= MIN_GAP_HIGH ? "high" : "medium";

  return {
    culprit: {
      sha: top.commit.sha,
      confidence,
      reasons: top.reasons,
    },
    topScore: top.score,
    runnerUpSha: runnerUp?.commit.sha ?? null,
  };
}

/// Convenience that wires the scoring against a `RepoEnrichmentInput`,
/// pulling resolved files automatically from evidence/affected/stack
/// locations. Used by the service layer after blame enrichment.
export function detectLikelyCulpritFromEnrichment(
  enrichment: RepoEnrichmentInput,
  signals: Omit<CulpritSignals, "resolvedFiles">
): CulpritDetectionResult {
  if (
    !enrichment.suspectedRegressions ||
    enrichment.suspectedRegressions.length === 0
  ) {
    return { culprit: null, topScore: 0, runnerUpSha: null };
  }
  const resolvedFiles = collectResolvedFiles(enrichment);
  return detectLikelyCulprit(enrichment.suspectedRegressions, {
    ...signals,
    resolvedFiles,
  });
}

// ---------------------------------------------------------------------------
// Scoring internals
// ---------------------------------------------------------------------------

type ScoreContext = {
  areaTokens: Set<string>;
  causeTokens: Set<string>;
  summaryTokens: Set<string>;
  areaText: string | undefined;
  causeText: string | undefined;
  resolvedFiles: string[];
  now: Date;
};

type ScoredCommit = {
  commit: CommitRef;
  score: number;
  reasons: string[];
};

/// Score weights — tuned conservatively. Increase only with evidence from
/// the eval set, otherwise we'll bias toward false positives.
const W_AREA_HIT = 2;
const W_AREA_OVERLAP = 1; // additional points for >1 keyword overlap
const W_CAUSE_HIT = 1.5;
const W_SUMMARY_HIT = 0.5;
const W_FILE_HIT_RATIO = 1.5; // multiplied by ratio of touched/resolved files
const W_RECENT_MERGE = 0.5;

function scoreCommit(commit: CommitRef, ctx: ScoreContext): ScoredCommit {
  const reasons: string[] = [];
  let score = 0;

  const messageTokens = tokenize(commit.message);

  // Affected-area match — strongest signal.
  const areaOverlap = intersectSize(messageTokens, ctx.areaTokens);
  if (areaOverlap > 0) {
    score += W_AREA_HIT;
    if (areaOverlap > 1) {
      score += W_AREA_OVERLAP * Math.min(areaOverlap - 1, 3);
    }
    if (ctx.areaText) {
      // Keep the reason short — the chip is one line in the rendered
      // packet. Trim quotes; trim length hard.
      reasons.push(
        `matches affected area: "${truncate(ctx.areaText, 40)}"`
      );
    } else {
      reasons.push("matches affected area");
    }
  }

  // Probable-root-cause match — slightly weaker. Don't double-count
  // tokens that already credited under affectedArea (the LLM often
  // repeats keywords across the two fields).
  const causeOnly = differenceWith(ctx.causeTokens, ctx.areaTokens);
  const causeOverlap = intersectSize(messageTokens, causeOnly);
  if (causeOverlap > 0) {
    score += W_CAUSE_HIT;
    if (ctx.causeText) {
      reasons.push(
        `matches probable root cause: "${truncate(ctx.causeText, 40)}"`
      );
    } else {
      reasons.push("matches probable root cause");
    }
  }

  // Summary match — same dedup against earlier signals. Doesn't
  // contribute a reason chip (would just be noise alongside the more
  // specific signals).
  const summaryOnly = differenceWith(
    differenceWith(ctx.summaryTokens, ctx.areaTokens),
    ctx.causeTokens
  );
  const summaryOverlap = intersectSize(messageTokens, summaryOnly);
  if (summaryOverlap > 0) {
    score += W_SUMMARY_HIT;
  }

  // File-hit ratio — how many of the resolved files this commit touched.
  // 0 when no files are resolved (common for cases without a connected
  // repo / for path-only locations the commit doesn't touch).
  if (ctx.resolvedFiles.length > 0) {
    const resolvedSet = new Set(ctx.resolvedFiles);
    const overlap = commit.touchedFiles.filter((f) =>
      resolvedSet.has(f)
    ).length;
    if (overlap > 0) {
      const ratio = overlap / ctx.resolvedFiles.length;
      score += W_FILE_HIT_RATIO * ratio;
      reasons.push(
        `touched ${overlap} of ${ctx.resolvedFiles.length} suspected file${ctx.resolvedFiles.length === 1 ? "" : "s"}`
      );
    }
  }

  // Recency — small bonus for commits inside the recent-merge window.
  // We trust the enrichment ranker for the bigger recency signal; this is
  // just a thumb on the scale to break ties when two commits are
  // otherwise tied on keyword/file signals.
  const ts = Date.parse(commit.date);
  if (Number.isFinite(ts)) {
    const ageDays = (ctx.now.getTime() - ts) / 86_400_000;
    if (ageDays >= 0 && ageDays <= RECENT_MERGE_WINDOW_DAYS) {
      score += W_RECENT_MERGE;
      reasons.push(formatRelativeAge(ageDays));
    }
  }

  return { commit, score, reasons };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tokenize(text: string | undefined): Set<string> {
  if (!text) return new Set();
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (t) => t.length >= MIN_KEYWORD_LENGTH && !STOPWORDS.has(t)
    );
  return new Set(tokens);
}

function intersectSize(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  // Iterate the smaller set for cache-friendly cost.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small) {
    if (large.has(t)) n += 1;
  }
  return n;
}

function differenceWith(a: Set<string>, b: Set<string>): Set<string> {
  if (a.size === 0) return new Set();
  if (b.size === 0) return new Set(a);
  const out = new Set<string>();
  for (const t of a) {
    if (!b.has(t)) out.add(t);
  }
  return out;
}

function collectResolvedFiles(enrichment: RepoEnrichmentInput): string[] {
  const seen = new Set<string>();
  if (enrichment.affectedAreaLocation) {
    seen.add(enrichment.affectedAreaLocation.file);
  }
  for (const loc of enrichment.stackLocations ?? []) {
    seen.add(loc.file);
  }
  if (enrichment.evidenceLocations) {
    for (const key of Object.keys(enrichment.evidenceLocations)) {
      for (const loc of enrichment.evidenceLocations[key]) {
        seen.add(loc.file);
      }
    }
  }
  return [...seen];
}

function truncate(s: string, max: number): string {
  const compact = s.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}…`;
}

function formatRelativeAge(ageDays: number): string {
  if (ageDays < 1) return "merged today";
  if (ageDays < 2) return "merged yesterday";
  return `merged ${Math.round(ageDays)} days ago`;
}
