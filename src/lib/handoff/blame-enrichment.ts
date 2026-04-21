/**
 * Handoff Packet blame enrichment (Phase 2.5 + 2.6).
 *
 * Pure adapter that decorates a `RepoEnrichmentInput` (Phase 2.3 output)
 * with commit-level provenance per resolved location:
 *
 *   - `RepoLocation.blame`  — "last changed by X · #842 · 2d ago" for every
 *     resolved location. As of Phase 2.6, blame is **line-level** when the
 *     location carries a `line` (using GitHub GraphQL blame ranges) and
 *     falls back to file-level (the most recent commit on the whole file)
 *     for path-only locations or when no range covers the requested line.
 *
 *   - `RepoEnrichmentInput.suspectedRegressions` — commits that touched any
 *     of the resolved files within the last N days, ranked by (a) how many
 *     resolved files the commit touched, then (b) recency. This is the "did
 *     X just break because of Y?" signal. Computed file-level — different
 *     lines on the same file collapse into one regression vote.
 *
 * What this module deliberately does NOT do:
 *   - Fetch commits or blame. The caller injects two closures so unit tests
 *     don't hit the network and the service layer can apply concurrency /
 *     per-request caching:
 *       * `resolveLineBlame(file, line?)`  — GitHub GraphQL blame
 *       * `listRecentCommits(file)`         — GitHub REST list-commits
 *   - Handle errors. The injected closures decide between "throw" and
 *     "return null/[]"; this module treats null/[] as "no data" and moves
 *     on. Per-file rejections never block other files (Promise.allSettled).
 *   - Render Markdown. That's `render-markdown.ts`.
 *
 * All public functions are deterministic given deterministic inputs — we
 * compare files lexically when ranking ties.
 */

import type {
  CommitRef,
  RepoEnrichmentInput,
  RepoLocation,
} from "@/lib/handoff/packet";

/// How many suspected regressions to surface on the packet. Keep small —
/// packet consumers (agents, humans) don't want to wade through 20 commits.
const MAX_SUSPECTED_REGRESSIONS = 5;

/// Recency window for suspected regressions. Commits older than this are
/// excluded from the `suspectedRegressions` list (they're still used for
/// `blame` on the location they touched — blame has no recency filter).
/// 30 days is long enough to catch weekly sprints but short enough to avoid
/// flooding with ancient rewrites.
const SUSPECTED_REGRESSION_DAYS = 30;

// ---------------------------------------------------------------------------
// Fetched commit shape consumed by the adapter
// ---------------------------------------------------------------------------

/// Minimal projection of `GithubCommitSummary` — we keep this decoupled
/// from the github/client type so a future `gitlab/client` etc. can plug in.
export type BlameCommit = {
  sha: string;
  message: string;
  /// Preferred display identity (GitHub login when available, otherwise the
  /// git-author name). Used for `RepoLocation.blame.author` and `CommitRef.author`.
  authorLogin: string | null;
  authorName: string;
  /// ISO-8601 UTC timestamp.
  date: string;
  /// Link to the commit on GitHub — used as `CommitRef.url`.
  htmlUrl: string;
};

export type BlameContext = {
  /// Resolves blame for a single `(file, line?)`. Should return the commit
  /// that last modified the requested line (when `line` is given) or the
  /// most recent commit on the file (when omitted, or when no range covers
  /// the line). Return `null` when no data is available — the adapter
  /// treats it as "skip blame for this location" rather than failing.
  /// The service layer is expected to cache per-file blame across calls so
  /// multiple lines on the same file don't fan out multiple API calls.
  resolveLineBlame: (
    file: string,
    line: number | undefined
  ) => Promise<BlameCommit | null>;

  /// Returns the most recent commits that touched `file`, newest first.
  /// Used for `suspectedRegressions` aggregation. Same caching contract as
  /// `resolveLineBlame`. Return `[]` when no data is available.
  listRecentCommits: (file: string) => Promise<BlameCommit[]>;

  /// Clock override used for the regression recency window. Defaults to
  /// `new Date()`. Exposed so tests (and deterministic re-runs of stored
  /// enrichments) can pin the window.
  now?: Date;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type EnrichBlameResult = {
  /// Clone of the input enrichment with `blame` populated on each location
  /// that had a successful commit lookup, plus `suspectedRegressions`
  /// (when any commits qualify).
  enrichment: RepoEnrichmentInput;
  /// Distinct file paths we queried commits for (regression aggregation).
  /// Useful for observability (e.g. logging "blame: 3 files, 2 regressions").
  filesQueried: string[];
  /// Distinct (file, line) pairs we resolved blame for. Phase 2.6 metric —
  /// when this is greater than `filesQueried.length`, line-level blame is
  /// genuinely doing work (multiple lines on the same file got distinct
  /// attributions).
  locationsBlamed: number;
};

/// Adds blame metadata + suspected regressions to a `RepoEnrichmentInput`.
/// Returns a new object; does not mutate the input.
export async function enrichBlame(
  enrichment: RepoEnrichmentInput,
  ctx: BlameContext
): Promise<EnrichBlameResult> {
  const files = collectUniqueFiles(enrichment);
  if (files.length === 0) {
    return { enrichment, filesQueried: [], locationsBlamed: 0 };
  }

  // Phase 2.6: collect every distinct (file, line?) so we can resolve
  // line-level blame. Different lines on the same file get separate
  // attribution — multiple authors per file is the common case.
  const locationKeys = collectUniqueLocationKeys(enrichment);

  // Fan out blame lookups in parallel. The service layer's BlameContext is
  // expected to cache per-file blame so multiple keys on the same file
  // share one network call.
  const blameSettled = await Promise.allSettled(
    locationKeys.map(async (key) => ({
      key,
      commit: await ctx.resolveLineBlame(key.file, key.line),
    }))
  );

  // Map: locationKey-string => blame. Keyed by the same `keyOf` we use when
  // attaching blame to locations during the rebuild.
  const blameByKey = new Map<string, CommitToBlame>();
  for (const result of blameSettled) {
    if (result.status !== "fulfilled") continue;
    const { key, commit } = result.value;
    if (!commit) continue;
    blameByKey.set(keyOf(key), toBlame(commit));
  }

  // Regression aggregation is still file-level — different lines on the
  // same file shouldn't double-count toward `fileHitCount`.
  const commitsSettled = await Promise.allSettled(
    files.map(async (file) => ({
      file,
      commits: await ctx.listRecentCommits(file),
    }))
  );
  const commitsByFile = new Map<string, BlameCommit[]>();
  for (const result of commitsSettled) {
    if (result.status !== "fulfilled") continue;
    const { file, commits } = result.value;
    if (commits.length === 0) continue;
    commitsByFile.set(file, commits);
  }

  // Rebuild the enrichment with blame attached. We keep structural fidelity
  // with the input (no extra fields, same order of arrays).
  const nextEvidenceLocations = enrichment.evidenceLocations
    ? mapRecord(enrichment.evidenceLocations, (locations) =>
        locations.map((loc) => attachBlame(loc, blameByKey))
      )
    : undefined;

  const nextAffectedArea = enrichment.affectedAreaLocation
    ? attachBlame(enrichment.affectedAreaLocation, blameByKey)
    : undefined;

  const nextStackLocations = enrichment.stackLocations
    ? enrichment.stackLocations.map((loc) => attachBlame(loc, blameByKey))
    : undefined;

  const suspectedRegressions = rankSuspectedRegressions(
    commitsByFile,
    files,
    ctx.now ? { now: ctx.now } : {}
  );

  const nextEnrichment: RepoEnrichmentInput = {
    repoFullName: enrichment.repoFullName,
    ref: enrichment.ref,
    ...(nextEvidenceLocations ? { evidenceLocations: nextEvidenceLocations } : {}),
    ...(nextAffectedArea ? { affectedAreaLocation: nextAffectedArea } : {}),
    ...(nextStackLocations ? { stackLocations: nextStackLocations } : {}),
    ...(suspectedRegressions.length > 0
      ? { suspectedRegressions }
      : {}),
  };

  return {
    enrichment: nextEnrichment,
    filesQueried: [...commitsByFile.keys()],
    locationsBlamed: blameByKey.size,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Collects every distinct file path from the enrichment. Order is
/// deterministic: affected area first, then stack locations, then evidence
/// locations by evidence-id key order. Used for regression aggregation,
/// which is file-level (not line-level).
export function collectUniqueFiles(enrichment: RepoEnrichmentInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  function add(loc: RepoLocation | undefined) {
    if (!loc) return;
    if (seen.has(loc.file)) return;
    seen.add(loc.file);
    out.push(loc.file);
  }

  add(enrichment.affectedAreaLocation);
  for (const loc of enrichment.stackLocations ?? []) add(loc);
  if (enrichment.evidenceLocations) {
    for (const key of Object.keys(enrichment.evidenceLocations)) {
      for (const loc of enrichment.evidenceLocations[key]) add(loc);
    }
  }
  return out;
}

export type LocationKey = { file: string; line: number | undefined };

/// Phase 2.6: every distinct (file, line?) pair from the enrichment. Two
/// locations on the same file but different lines produce two keys — they
/// will resolve to (potentially) different commits at the line granularity.
/// Two locations on the same file with the SAME line collapse to one key.
/// Path-only locations (line === undefined) produce a key with `line:
/// undefined`, which the caller resolves as "most recent commit on the
/// whole file".
export function collectUniqueLocationKeys(
  enrichment: RepoEnrichmentInput
): LocationKey[] {
  const seen = new Set<string>();
  const out: LocationKey[] = [];

  function add(loc: RepoLocation | undefined) {
    if (!loc) return;
    const key: LocationKey = { file: loc.file, line: loc.line };
    const k = keyOf(key);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(key);
  }

  add(enrichment.affectedAreaLocation);
  for (const loc of enrichment.stackLocations ?? []) add(loc);
  if (enrichment.evidenceLocations) {
    for (const key of Object.keys(enrichment.evidenceLocations)) {
      for (const loc of enrichment.evidenceLocations[key]) add(loc);
    }
  }
  return out;
}

/// Stable string key for a (file, line) pair. `line: undefined` collapses
/// to a sentinel so all path-only locations on the same file dedupe.
export function keyOf(key: LocationKey): string {
  return `${key.file}\u0000${key.line ?? ""}`;
}

type CommitToBlame = NonNullable<RepoLocation["blame"]>;

function toBlame(commit: BlameCommit): CommitToBlame {
  const pr = extractPrNumber(commit.message);
  return {
    author: commit.authorLogin ?? commit.authorName,
    commitSha: commit.sha,
    commitMessage: commit.message.split("\n")[0].trim(),
    date: commit.date,
    ...(pr !== null ? { prNumber: pr } : {}),
  };
}

/// Parses a PR number out of a squash-merge or merge-commit message. GitHub
/// defaults to appending ` (#1234)` on squash commits and `Merge pull
/// request #1234` on merge commits. We're lenient — any `#N` in the first
/// line counts as long as N is 1-6 digits (covers every realistic repo).
export function extractPrNumber(message: string): number | null {
  const firstLine = message.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/#(\d{1,6})\b/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function attachBlame(
  location: RepoLocation,
  blameByKey: Map<string, CommitToBlame>
): RepoLocation {
  const blame = blameByKey.get(
    keyOf({ file: location.file, line: location.line })
  );
  if (!blame) return location;
  return { ...location, blame };
}

function mapRecord<V>(
  rec: Record<string, V>,
  fn: (value: V) => V
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of Object.keys(rec)) {
    out[key] = fn(rec[key]);
  }
  return out;
}

type ScoredCommit = {
  ref: CommitRef;
  /// Number of resolved files this commit touched — the primary ranking
  /// signal. A commit that touches 3 resolved files is more likely to be
  /// the regression than one that only touched 1.
  fileHitCount: number;
};

export function rankSuspectedRegressions(
  commitsByFile: Map<string, BlameCommit[]>,
  allFiles: string[],
  options: { now?: Date; maxResults?: number; daysWindow?: number } = {}
): CommitRef[] {
  const now = options.now ?? new Date();
  const maxResults = options.maxResults ?? MAX_SUSPECTED_REGRESSIONS;
  const windowMs = (options.daysWindow ?? SUSPECTED_REGRESSION_DAYS) * 86_400_000;
  const cutoff = now.getTime() - windowMs;
  void allFiles; // reserved for future scoring weights (e.g. boost top-ranked files)

  // Aggregate: for each commit SHA, collect the set of resolved files it
  // appeared in.
  const bySha = new Map<string, { commit: BlameCommit; files: Set<string> }>();
  for (const [file, commits] of commitsByFile) {
    for (const commit of commits) {
      const ts = Date.parse(commit.date);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const existing = bySha.get(commit.sha);
      if (existing) {
        existing.files.add(file);
      } else {
        bySha.set(commit.sha, {
          commit,
          files: new Set([file]),
        });
      }
    }
  }

  const scored: ScoredCommit[] = [];
  for (const { commit, files } of bySha.values()) {
    const pr = extractPrNumber(commit.message);
    const touchedFiles = [...files].sort();
    scored.push({
      fileHitCount: touchedFiles.length,
      ref: {
        sha: commit.sha,
        message: commit.message.split("\n")[0].trim(),
        author: commit.authorLogin ?? commit.authorName,
        date: commit.date,
        ...(pr !== null ? { prNumber: pr } : {}),
        url: commit.htmlUrl,
        touchedFiles,
      },
    });
  }

  scored.sort((a, b) => {
    if (b.fileHitCount !== a.fileHitCount) {
      return b.fileHitCount - a.fileHitCount;
    }
    // Secondary: newer first.
    const dateDiff = Date.parse(b.ref.date) - Date.parse(a.ref.date);
    if (dateDiff !== 0) return dateDiff;
    // Tertiary: stable by SHA for determinism in tests.
    return a.ref.sha.localeCompare(b.ref.sha);
  });

  return scored.slice(0, maxResults).map((s) => s.ref);
}
