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
// Phase 2.8 — negative evidence tunables
// ---------------------------------------------------------------------------

/// Penalty applied when a commit's *every* touched file is in a scope the
/// diagnosis clearly isn't about (e.g. every file is a test, but the
/// symptoms are in production code). Large enough to strip a commit out
/// of medium confidence, small enough that a strong positive-signal match
/// can still carry it over the bar.
const P_KIND_ONLY = 3;

/// Penalty applied when a contradiction contains an exclusivity marker
/// (e.g. "iOS only", "not Android") and every file in the commit falls
/// inside the excluded scope. Smaller than `P_KIND_ONLY` because
/// contradiction phrasing is noisier than path classification.
const P_CONTRADICTS_SCOPE = 2;

/// Any negative signal caps the culprit at `medium` confidence — a
/// demoted commit must never render with a "Likely culprit" label,
/// regardless of how high the raw positive score was.
const NEGATIVE_SIGNAL_CONFIDENCE_CAP: LikelyCulprit["confidence"] = "medium";

// ---------------------------------------------------------------------------
// Phase 2.9 — diff-aware tunables
// ---------------------------------------------------------------------------

/// Bonus credit when a commit's diff actually touches one of the
/// (file, line) pairs from the evidence stack frames. Precision here
/// is much higher than file-hit ratio — "this commit changed line 42
/// which appears in the crash trace" is a qualitatively stronger
/// signal than "this commit touched checkout.ts somewhere". Weight
/// picked so a single line hit pushes a borderline commit (score ~3)
/// past MIN_SCORE_HIGH, but a lone line hit with no keyword overlap
/// still needs other signals to reach the threshold.
const W_DIFF_LINE_HIT = 2;

// ---------------------------------------------------------------------------
// Phase 2.9.1 — proximity tunables
// ---------------------------------------------------------------------------

/// Max line distance that still counts as "near" the stack frame.
/// Tight enough to catch "broke the caller ± a few lines above / below"
/// without picking up random unrelated edits elsewhere in the file.
const DIFF_LINE_NEAR_WINDOW = 10;

/// Smaller bonus awarded when the diff didn't exactly hit the stack
/// line but changed something inside the near window. Worth enough to
/// flip ties against a commit with no diff info, but strictly less
/// than an exact hit so the scorer still prefers a commit that
/// actually modified the crashing line.
const W_DIFF_LINE_NEAR = 1;

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
  /// Phase 2.8. Free-text contradictions from the LLM diagnosis. We scan
  /// these for exclusivity markers ("only on iOS", "not Android") to
  /// demote commits whose scope disagrees with the evidence. Empty array
  /// or `undefined` → no contradiction penalties applied.
  contradictions?: string[];
  /// Phase 2.9. (file, line) pairs extracted from the evidence stack
  /// frames / resolved `RepoLocation`s. Paired with `diffProbesBySha`
  /// below to power the diff-aware bonus: a commit whose diff actually
  /// touches a stack-frame line scores higher than one that merely
  /// touched the file.
  stackLines?: Array<{ file: string; line: number }>;
  /// Phase 2.9. Per-commit probe that tests whether the commit's diff
  /// touches a given (file, line) pair on the POST-change side. The
  /// caller is responsible for fetching the diff (expensive — usually
  /// only for top-K candidates) and wrapping it in a probe function;
  /// the scorer stays pure and has no upstream dependency.
  /// Missing entries → no diff signal for that commit.
  diffProbesBySha?: Map<string, CommitDiffProbe>;
  /// Clock override for the recency signal. Defaults to `new Date()`.
  now?: Date;
};

/// Adapter-owned probe shape. Returns the minimum line distance
/// between `line` and any hunk in the commit's diff for `file`:
///   - `0`    → exact hit (a hunk covers `line`).
///   - `> 0`  → distance in lines to the nearest hunk edge
///              (Phase 2.9.1 proximity window credit).
///   - `null` → file not in diff, invalid line, or every hunk is
///              a pure deletion (no post-change coordinate).
///
/// Service-layer callers wrap their fetched `GithubCommitDiff` in a
/// closure that invokes `diffDistanceToLine` internally, keeping the
/// scorer decoupled from the github-client types.
export type CommitDiffProbe = (file: string, line: number) => number | null;

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
  /// Phase 2.9. SHAs of the top candidates ordered by post-penalty
  /// score (desc) then the same tiebreakers the picker uses. The
  /// service layer reads this after the cheap first pass to decide
  /// which commits are worth fetching diffs for — typically the first
  /// 2-3. Always includes the picked culprit first (when non-null).
  topCandidateShas: string[];
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
    return {
      culprit: null,
      topScore: 0,
      runnerUpSha: null,
      topCandidateShas: [],
    };
  }

  const areaTokens = tokenize(signals.affectedArea);
  const causeTokens = tokenize(signals.probableRootCause);
  const summaryTokens = tokenize(signals.summary);
  const resolvedFiles = signals.resolvedFiles ?? [];
  const now = signals.now ?? new Date();
  const excludedScopes = extractContradictionScopes(signals.contradictions);
  const stackLines = (signals.stackLines ?? []).filter(
    (s) => Number.isFinite(s.line) && s.line > 0
  );
  const diffProbesBySha = signals.diffProbesBySha;
  // The diagnosis tokens tell us which kinds of files are legitimately
  // in-scope. If the affected area IS about tests, then test-only commits
  // shouldn't be demoted. Same for docs / config / platform scopes.
  const diagnosisScopes = inferDiagnosisScopes([
    signals.affectedArea,
    signals.probableRootCause,
    signals.summary,
  ]);

  const scored = regressions.map((commit) =>
    scoreCommit(commit, {
      areaTokens,
      causeTokens,
      summaryTokens,
      areaText: signals.affectedArea,
      causeText: signals.probableRootCause,
      resolvedFiles,
      excludedScopes,
      diagnosisScopes,
      stackLines,
      diffProbesBySha,
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
  // `topCandidateShas` is exposed on every return path so service
  // callers can decide which commits are worth an expensive diff
  // fetch. Cap at 5 to keep the log line + call fan-out reasonable.
  const topCandidateShas = scored.slice(0, 5).map((s) => s.commit.sha);

  // Threshold check uses `rawScore` (positives only) so a commit with
  // strong positive signal still surfaces when heavily penalised — but
  // it lands in the chip as "Possible culprit" with a negative reason
  // bullet rather than silently disappearing.
  if (top.rawScore < MIN_SCORE_MEDIUM) {
    return {
      culprit: null,
      topScore: top.score,
      runnerUpSha: runnerUp?.commit.sha ?? null,
      topCandidateShas,
    };
  }

  // Confidence starts from the raw score + gap, then is capped whenever
  // any negative signal fired on the picked commit. This means a
  // strongly-scoring commit whose every file is a test can still be
  // returned as the culprit (the LLM may still want to look at it), but
  // the chip will carry "Possible culprit" wording instead of "Likely",
  // and the rationale will include the negative reason so the receiver
  // can audit the demotion.
  const rawConfidence: LikelyCulprit["confidence"] =
    top.score >= MIN_SCORE_HIGH && gap >= MIN_GAP_HIGH ? "high" : "medium";
  const confidence: LikelyCulprit["confidence"] = top.penalized
    ? NEGATIVE_SIGNAL_CONFIDENCE_CAP
    : rawConfidence;

  return {
    culprit: {
      sha: top.commit.sha,
      confidence,
      reasons: top.reasons,
    },
    topScore: top.score,
    runnerUpSha: runnerUp?.commit.sha ?? null,
    topCandidateShas,
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
    return {
      culprit: null,
      topScore: 0,
      runnerUpSha: null,
      topCandidateShas: [],
    };
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
  /// Phase 2.8. Scopes called out as "only on X" / "not X" in the
  /// contradictions. A commit whose files all live in an excluded scope
  /// gets demoted.
  excludedScopes: Set<Scope>;
  /// Phase 2.8. Scopes that the diagnosis IS about (e.g. "the test suite
  /// is flaky" → `{test}`). When a commit's scope matches one of these,
  /// we suppress the kind-only penalty — it's not a false positive, it's
  /// the right kind of commit to suspect.
  diagnosisScopes: Set<Scope>;
  /// Phase 2.9. Normalised (file, line) pairs from the evidence stack
  /// frames. Only entries with a finite, positive `line` survive the
  /// filter in `detectLikelyCulprit` — the scorer doesn't need to
  /// re-validate.
  stackLines: Array<{ file: string; line: number }>;
  /// Phase 2.9. Per-commit diff probe map. Undefined when the service
  /// didn't fetch any diffs (cheapest path); empty map behaves the
  /// same. Individual misses (commit with no entry) just skip the
  /// bonus for that commit.
  diffProbesBySha: Map<string, CommitDiffProbe> | undefined;
  now: Date;
};

type ScoredCommit = {
  commit: CommitRef;
  /// Positive signals only — used as the "is this commit worth
  /// surfacing at all?" threshold check. A commit with strong raw
  /// signal but heavy penalty (e.g. "fix: checkout retry" in
  /// docs/checkout.md) still surfaces, just with "Possible culprit"
  /// wording + the negative reason chip.
  rawScore: number;
  /// Post-penalty score — used for ranking (so clean commits beat
  /// penalised ones with similar raw signal) and for confidence
  /// banding.
  score: number;
  reasons: string[];
  /// Phase 2.8. `true` when any negative-evidence penalty fired. Caps
  /// the confidence band at `medium` regardless of raw score.
  penalized: boolean;
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
  // `rawScore` accumulates ONLY the positive signals so we can use it as
  // the surface-worthiness threshold. `score` is raw minus any negative
  // penalties and drives ranking + confidence.
  let rawScore = 0;

  const messageTokens = tokenize(commit.message);

  // Local helper: every positive credit goes through here so rawScore
  // and score stay in lockstep for positives. Penalties are applied to
  // `score` only, below.
  const credit = (amount: number) => {
    score += amount;
    rawScore += amount;
  };

  // Affected-area match — strongest signal.
  const areaOverlap = intersectSize(messageTokens, ctx.areaTokens);
  if (areaOverlap > 0) {
    credit(W_AREA_HIT);
    if (areaOverlap > 1) {
      credit(W_AREA_OVERLAP * Math.min(areaOverlap - 1, 3));
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
    credit(W_CAUSE_HIT);
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
    credit(W_SUMMARY_HIT);
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
      credit(W_FILE_HIT_RATIO * ratio);
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
      credit(W_RECENT_MERGE);
      reasons.push(formatRelativeAge(ageDays));
    }
  }

  // Phase 2.9 + 2.9.1 — diff-aware precision bonus with proximity.
  // When the service has fetched this commit's diff (expensive;
  // typically only for top-K candidates), we look for the CLOSEST
  // hunk to each stack-frame line:
  //
  //   - distance 0  → exact hit (the commit changed the crashing
  //     line). Strong positive signal — credit W_DIFF_LINE_HIT.
  //   - distance ≤ DIFF_LINE_NEAR_WINDOW → near hit (commit changed
  //     a line nearby; e.g. "broke the caller one line above").
  //     Smaller positive signal — credit W_DIFF_LINE_NEAR.
  //   - anything else → no bonus.
  //
  // We credit at most once per commit and prefer the best (smallest-
  // distance) match for the reason bullet. This keeps the score
  // bounded and the reason chip deterministic.
  const probe = ctx.diffProbesBySha?.get(commit.sha);
  if (probe && ctx.stackLines.length > 0) {
    let bestDistance: number | null = null;
    let bestLine: { file: string; line: number } | null = null;
    for (const s of ctx.stackLines) {
      const d = probe(s.file, s.line);
      if (d === null) continue;
      if (bestDistance === null || d < bestDistance) {
        bestDistance = d;
        bestLine = s;
        if (d === 0) break; // can't get better than exact
      }
    }
    if (bestLine !== null && bestDistance !== null) {
      if (bestDistance === 0) {
        credit(W_DIFF_LINE_HIT);
        reasons.push(
          `diff touches ${bestLine.file}:${bestLine.line} (stack frame)`
        );
      } else if (bestDistance <= DIFF_LINE_NEAR_WINDOW) {
        credit(W_DIFF_LINE_NEAR);
        reasons.push(
          `diff touches ${bestLine.file}:${bestLine.line} (stack frame, ±${bestDistance} lines)`
        );
      }
    }
  }

  // Phase 2.8 — negative-evidence penalties. Applied AFTER positive
  // signals so the raw score is still a meaningful observability signal
  // (we log it). Penalty reasons are prefixed with "but " so the rendered
  // chip reads as "touched 2/3 files · but all touched files are tests".
  let penalized = false;

  // Penalty 1 — kind-only commit (test-only / docs-only / config-only)
  // when the diagnosis isn't about that kind. `classifyCommitKind`
  // returns the exclusive kind ("test" | "docs" | "config") only when
  // ALL touched files fall in it; mixed commits are safe from this
  // penalty.
  const commitKind = classifyCommitKind(commit.touchedFiles);
  if (commitKind && !ctx.diagnosisScopes.has(commitKind)) {
    score -= P_KIND_ONLY;
    penalized = true;
    reasons.push(
      `but all touched files are ${commitKind === "test" ? "tests" : commitKind}`
    );
  }

  // Penalty 2 — commit's scope disjoint from the diagnosis. When a
  // contradiction says "iOS only" and the commit touched only Android
  // files, demote.
  if (ctx.excludedScopes.size > 0) {
    const commitScopes = classifyCommitScopes(commit.touchedFiles);
    if (commitScopes.size > 0) {
      // Every scope the commit falls in is excluded → full scope
      // disagreement. A commit that straddles included + excluded scopes
      // is safe from this penalty; we only fire when there's nothing
      // "inside" the evidence scope.
      const allExcluded = [...commitScopes].every((s) =>
        ctx.excludedScopes.has(s)
      );
      if (allExcluded) {
        score -= P_CONTRADICTS_SCOPE;
        penalized = true;
        const scopeList = [...commitScopes].join("/");
        reasons.push(
          `but contradicts scope: files are ${scopeList}-only`
        );
      }
    }
  }

  return { commit, rawScore, score, reasons, penalized };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tokenize(text: string | undefined): Set<string> {
  if (!text) return new Set();
  // Phase 2.8.1 calibration: split camelCase / PascalCase boundaries
  // BEFORE lowercasing so identifiers like `submitCheckout` tokenize as
  // {"submit", "checkout"} and overlap with area/cause text phrased in
  // plain english. Without this, real-world commit messages quoting
  // method names score zero against prose area descriptions.
  //
  // Three passes cover common identifier shapes:
  //   - `fooBar` → `foo Bar`
  //   - `XMLParser` → `XML Parser`
  //   - `parseJSON2` → `parse JSON 2` (letter→digit boundary)
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2");
  const tokens = split
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

// ---------------------------------------------------------------------------
// Phase 2.8 — scope classification + contradiction extraction
// ---------------------------------------------------------------------------

/// Scope tags a file can live in. Kept deliberately small — we only
/// include scopes where misclassification is low and the penalty
/// signal is strong. Adding more (e.g. `schema`, `migration`) without
/// matching LLM vocabulary would just produce noise.
export type Scope =
  | "test"
  | "docs"
  | "config"
  | "ios"
  | "android"
  | "frontend"
  | "backend";

/// Exclusive "kind" of a commit — the subset of `Scope` we use for the
/// kind-only penalty. Only returned when ALL touched files fall in the
/// same kind; mixed-kind commits are undefined (safe).
type CommitKind = Extract<Scope, "test" | "docs" | "config">;

/// Classifies a single file path into zero-or-more scopes. Returns the
/// full set so a file can be tagged as, say, `ios + frontend`.
///
/// Patterns are deliberately conservative. A few rules of thumb:
///   - Test patterns require explicit test-folder/file shape.
///   - Docs patterns include `.md`/`.mdx` but exclude `*.test.md` etc.
///   - Config patterns cover only top-level tooling (lockfiles, CI,
///     formatter configs) — not application config (which usually
///     reflects real behaviour).
export function classifyFileScopes(path: string): Set<Scope> {
  const out = new Set<Scope>();
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? "";

  // --- test ---
  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)__tests__\//.test(normalized) ||
    /(^|\/)tests?\//.test(normalized) ||
    /(^|\/)e2e\//.test(normalized) ||
    /(^|\/)cypress\//.test(normalized) ||
    /(^|\/)playwright\//.test(normalized) ||
    /\.stories\.[jt]sx?$/.test(normalized)
  ) {
    out.add("test");
  }

  // --- docs ---
  if (
    /\.(md|mdx|rst|adoc|txt)$/.test(normalized) ||
    /(^|\/)docs?\//.test(normalized) ||
    base === "readme" ||
    base.startsWith("readme.") ||
    base === "changelog" ||
    base.startsWith("changelog.") ||
    base === "contributing" ||
    base.startsWith("contributing.")
  ) {
    out.add("docs");
  }

  // --- config (build/tooling only — not application config) ---
  if (
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "pnpm-lock.yaml" ||
    base === "bun.lockb" ||
    base === "gemfile.lock" ||
    base === "cargo.lock" ||
    base === "poetry.lock" ||
    base === ".gitignore" ||
    base === ".dockerignore" ||
    base === ".prettierrc" ||
    base.startsWith(".prettierrc.") ||
    base === ".prettierignore" ||
    base.startsWith(".eslintrc") ||
    base === ".editorconfig" ||
    base === "dockerfile" ||
    base.endsWith(".dockerfile") ||
    /(^|\/)\.github\//.test(normalized) ||
    /(^|\/)\.circleci\//.test(normalized) ||
    /(^|\/)\.husky\//.test(normalized) ||
    base === "renovate.json" ||
    base === "dependabot.yml"
  ) {
    out.add("config");
  }

  // --- platform: ios / android ---
  if (
    /(^|\/)ios\//.test(normalized) ||
    /\.(swift|m|mm)$/.test(normalized) ||
    /\.xcodeproj\//.test(normalized) ||
    base.endsWith(".xcconfig")
  ) {
    out.add("ios");
  }
  if (
    /(^|\/)android\//.test(normalized) ||
    /\.(kt|kts)$/.test(normalized) ||
    base === "androidmanifest.xml" ||
    /(^|\/)gradle\//.test(normalized)
  ) {
    out.add("android");
  }

  // --- frontend / backend (high-confidence shapes only) ---
  if (
    /\.(tsx|jsx|vue|svelte)$/.test(normalized) ||
    /\.(css|scss|sass|less)$/.test(normalized) ||
    /(^|\/)(components?|pages?|views?|ui|client|web|frontend)\//.test(
      normalized
    )
  ) {
    out.add("frontend");
  }
  if (
    /(^|\/)(server|backend|api|workers?|services?|jobs?|routes?)\//.test(
      normalized
    ) ||
    /\.(rb|py|go|rs|java|cs|ex|exs)$/.test(normalized)
  ) {
    out.add("backend");
  }

  return out;
}

/// Union of file scopes across every touched file, for the contradiction
/// penalty. A commit gets tagged with every scope any of its files hits.
export function classifyCommitScopes(touchedFiles: string[]): Set<Scope> {
  const out = new Set<Scope>();
  for (const f of touchedFiles) {
    for (const s of classifyFileScopes(f)) {
      out.add(s);
    }
  }
  return out;
}

/// Returns the exclusive kind of a commit when EVERY touched file falls
/// in the same `test`/`docs`/`config` bucket. Returns `null` for mixed
/// commits (safe: no penalty) or for commits whose files don't cleanly
/// classify. Intentionally stricter than `classifyCommitScopes` — a
/// single mixed-kind file protects the commit from the `P_KIND_ONLY`
/// penalty.
export function classifyCommitKind(
  touchedFiles: string[]
): CommitKind | null {
  if (touchedFiles.length === 0) return null;
  const kinds = new Set<CommitKind>();
  for (const file of touchedFiles) {
    const scopes = classifyFileScopes(file);
    // Does this file qualify as test / docs / config?
    let kind: CommitKind | null = null;
    if (scopes.has("test")) kind = "test";
    else if (scopes.has("docs")) kind = "docs";
    else if (scopes.has("config")) kind = "config";
    if (!kind) return null; // Any non-kind file breaks exclusivity.
    kinds.add(kind);
  }
  // All files must share ONE kind. ["test", "docs"] mix → null.
  return kinds.size === 1 ? [...kinds][0]! : null;
}

/// Extracts scope tokens from the diagnosis's "positive space" fields
/// (affectedArea, probableRootCause, summary). When the diagnosis IS
/// about tests or docs, we suppress the `P_KIND_ONLY` penalty for
/// commits of that kind — otherwise a legitimately-suspected
/// test-updating commit would get wrongly demoted.
export function inferDiagnosisScopes(texts: (string | undefined)[]): Set<Scope> {
  const out = new Set<Scope>();
  const joined = texts
    .filter((t): t is string => typeof t === "string")
    .join(" ")
    .toLowerCase();
  if (joined.length === 0) return out;
  // Word-boundary matches so we don't pick up "testing" for "test"
  // scope (too generic). Use specific plural / noun forms only.
  if (/\b(tests?|test suite|spec|specs|flak(y|e|iness))\b/.test(joined)) {
    out.add("test");
  }
  if (/\b(docs?|documentation|readme|changelog)\b/.test(joined)) {
    out.add("docs");
  }
  if (
    /\b(lockfile|lock file|dependency|dependencies|package\.json|ci(?:\/cd)?|pipeline|build config)\b/.test(
      joined
    )
  ) {
    out.add("config");
  }
  if (/\b(ios|iphone|ipad|safari mobile)\b/.test(joined)) out.add("ios");
  if (/\b(android|kotlin)\b/.test(joined)) out.add("android");
  if (/\b(frontend|front-end|client-side|ui|browser)\b/.test(joined)) {
    out.add("frontend");
  }
  if (
    /\b(backend|back-end|server-side|server|api|worker)\b/.test(joined)
  ) {
    out.add("backend");
  }
  return out;
}

/// Scans free-text contradictions for exclusivity patterns ("only on
/// iOS", "not Android", "server-side only") and returns the set of
/// scopes the diagnosis is saying the bug ISN'T in.
///
/// Patterns recognised (case-insensitive):
///   - "only on <scope>" / "only in <scope>" / "only <scope>"
///   - "<scope> only" / "<scope>-only"
///   - "not on <scope>" / "not in <scope>" / "not <scope>"
///   - "doesn't / does not / no / never ... <scope>"
///
/// Ambiguity handling:
///   - "X only" → the bug is in X, so NOT-X is excluded. We flip using
///     a small known pairing (ios↔android, frontend↔backend). Unknown
///     flips are ignored — we'd rather miss a penalty than apply a
///     wrong one.
///   - "not X" → X is excluded directly.
///   - Double negatives and "not only X" are skipped for safety.
export function extractContradictionScopes(
  contradictions: string[] | undefined
): Set<Scope> {
  const out = new Set<Scope>();
  if (!contradictions || contradictions.length === 0) return out;

  const OPPOSITE: Partial<Record<Scope, Scope[]>> = {
    ios: ["android"],
    android: ["ios"],
    frontend: ["backend"],
    backend: ["frontend"],
  };

  const SCOPE_VOCAB: { words: string[]; scope: Scope }[] = [
    { words: ["ios", "iphone", "ipad"], scope: "ios" },
    { words: ["android"], scope: "android" },
    {
      words: ["frontend", "front-end", "client-side", "ui", "browser"],
      scope: "frontend",
    },
    {
      words: ["backend", "back-end", "server-side", "server", "api"],
      scope: "backend",
    },
  ];

  for (const raw of contradictions) {
    if (typeof raw !== "string") continue;
    const text = raw.toLowerCase();
    // "not only X" is ambiguous — skip it entirely to avoid flipping in
    // the wrong direction.
    if (/\bnot\s+only\b/.test(text)) continue;

    // Up to 4 intervening short tokens between the marker and the scope
    // word so phrases like "Only reproduces on iOS" / "Doesn't happen on
    // Android" / "Not an Android issue" all match. Bounded so we don't
    // accidentally pair distant markers with distant scope mentions in
    // the same sentence (that bit us in an earlier prototype).
    const GAP = "(?:\\s+\\w+){0,4}\\s+";

    for (const { words, scope } of SCOPE_VOCAB) {
      for (const word of words) {
        const w = escapeRegex(word);
        // "X only" / "X-only" / "only on X" → bug IS in X → exclude opposite.
        if (
          new RegExp(`\\b${w}[\\s-]only\\b`).test(text) ||
          new RegExp(`\\bonly${GAP}${w}\\b`).test(text)
        ) {
          for (const opp of OPPOSITE[scope] ?? []) {
            out.add(opp);
          }
          continue;
        }
        // "not X" / "not on X" / "doesn't X" / "no X" / "isn't X" / "never X"
        // / "without X". X is excluded directly.
        if (
          new RegExp(
            `\\b(?:not|no|never|doesn'?t|does\\s+not|isn'?t|without)${GAP}${w}\\b`
          ).test(text)
        ) {
          out.add(scope);
        }
      }
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
