/**
 * Handoff enrichment service (Phase 2.3).
 *
 * Bridges the Handoff Packet builder (pure, in-memory) with the repo index
 * (Prisma-backed). At packet-build time we:
 *
 *   1. Pick the snapshot to enrich against (case-scoped repo link, or the
 *      workspace's sole linked repo if the case hasn't been explicitly
 *      scoped yet — "one repo per case" policy with a pragmatic default).
 *   2. Preload files + symbols in a single query each, then create a pair
 *      of closures that call the pure resolver — much faster than the
 *      per-call resolvePathInSnapshot/resolveSymbolInSnapshot helpers,
 *      which re-query Prisma every time.
 *   3. Call the pure `enrichPacketInput` adapter.
 *   4. If the snapshot is stale (or missing), kick off a background resync
 *      so the NEXT packet is enriched from fresh data. We never block the
 *      current request on GitHub API latency.
 *
 * Failure modes are all non-fatal — the whole point is that handoff must
 * still work when the repo index is absent, unauthenticated, or broken.
 * The service logs and returns `undefined` in those cases, and the packet
 * builder falls back to its pre-2.3 behaviour.
 */

import type { RepoFileKind, RepoSymbolKind } from "@prisma/client";

import {
  enrichBlame,
  type BlameCommit,
  type BlameContext,
} from "@/lib/handoff/blame-enrichment";
import { detectLikelyCulpritFromEnrichment } from "@/lib/handoff/culprit-detection";
import type { HandoffPacketInput, RepoEnrichmentInput } from "@/lib/handoff/packet";
import {
  enrichPacketInput,
  type EnrichmentContext,
} from "@/lib/handoff/repo-enrichment";
import {
  getFileBlameRanges,
  GithubApiError,
  listCommitsForPath,
  type GithubBlameResult,
  type GithubCommitSummary,
} from "@/lib/github/client";
import { prisma } from "@/lib/prisma";
import {
  resolvePath,
  resolveSymbol,
  type ResolverInputFile,
  type ResolverInputSymbol,
} from "@/lib/repo-index/resolver";
import { getDecryptedAccessToken } from "@/lib/services/github-account-service";
import {
  isRepoSnapshotStale,
  syncRepoTree,
} from "@/lib/services/repo-index-service";

// ---------------------------------------------------------------------------
// Blame enrichment tunables (Phase 2.5)
// ---------------------------------------------------------------------------

/// Cap the number of distinct files we query for blame per handoff. Keeps
/// the GitHub cost bounded even on packets with lots of evidence locations.
/// Files beyond the cap still ship in the packet, just without `blame`.
const BLAME_FILE_BUDGET = 8;

/// Commits per file. Enough to (a) populate the top blame and (b) give the
/// regression ranker a few candidates to dedupe across files.
const BLAME_COMMITS_PER_FILE = 5;

/// Max concurrent GitHub calls. GitHub's authenticated budget is 5000/hour;
/// fan-out of 3-4 per handoff is fine while still keeping tail latency low.
const BLAME_CONCURRENCY = 3;

/// Per-file fetch timeout. If a single commits call takes too long the
/// whole handoff waits, so fail fast and let the packet ship without that
/// file's blame.
const BLAME_FETCH_TIMEOUT_MS = 4_000;

const LOG_PREFIX = "[handoff-enrichment]";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LoadRepoEnrichmentForCaseParams = {
  userId: string;
  caseId: string;
  /// Already-built handoff input. Passed through to the pure enrichment
  /// adapter — we never re-derive it from Prisma here.
  input: HandoffPacketInput;
};

/// Resolves the snapshot to enrich against, loads files + symbols, and
/// invokes the pure enrichment adapter. Returns `undefined` when no repo
/// link applies or when no snapshot exists yet (the first packet for a new
/// repo is unenriched on purpose — we kick off a background sync so the
/// next one benefits).
export async function loadRepoEnrichmentForCase(
  params: LoadRepoEnrichmentForCaseParams
): Promise<RepoEnrichmentInput | undefined> {
  const resolution = await pickRepoLinkForCase(params.userId, params.caseId);
  if (!resolution) return undefined;

  const { repoLink, snapshotId } = resolution;

  if (!snapshotId) {
    // No snapshot yet. Kick off a background sync so the next handoff gets
    // enrichment, but produce an unenriched packet this time — we don't
    // want to block the user on a multi-second GitHub fetch.
    triggerBackgroundSync({
      userId: params.userId,
      workspaceId: repoLink.workspaceId,
      repoLinkId: repoLink.id,
      reason: "no_snapshot",
    });
    return undefined;
  }

  // If the snapshot is stale (>24h since tree sync or explicitly FAILED), a
  // background refresh keeps future handoffs fresh. Current packet uses the
  // stale data — better than nothing.
  const stale = await isRepoSnapshotStale(repoLink.id).catch(() => false);
  if (stale) {
    triggerBackgroundSync({
      userId: params.userId,
      workspaceId: repoLink.workspaceId,
      repoLinkId: repoLink.id,
      reason: "stale_snapshot",
    });
  }

  const [files, symbols] = await Promise.all([
    loadFilesForSnapshot(snapshotId),
    loadSymbolsForSnapshot(snapshotId),
  ]);

  if (files.length === 0) {
    // Snapshot exists but no files — most likely a FAILED or SYNCING row.
    // Don't block the packet on a broken index.
    return undefined;
  }

  const ctx: EnrichmentContext = {
    repoFullName: `${repoLink.ownerLogin}/${repoLink.repoName}`,
    ref: repoLink.latestSnapshotCommitSha,
    resolvePath: (hint, options) => resolvePath(hint, files, options),
    resolveSymbol: (query, options) => resolveSymbol(query, symbols, options),
  };

  let baseEnrichment: RepoEnrichmentInput;
  try {
    baseEnrichment = enrichPacketInput(params.input, ctx);
  } catch (error) {
    // Enrichment is best-effort — never let a bug here take out handoff.
    console.warn(`${LOG_PREFIX} enrichPacketInput threw`, error);
    return undefined;
  }

  // Phase 2.5: layer blame + suspected regressions on top of the resolved
  // enrichment. This hits GitHub's list-commits API per unique file, so it
  // only runs when the user has a connected GitHub account; any failure
  // falls back to the pre-2.5 enrichment without throwing.
  const blameEnriched = await applyBlameEnrichment({
    userId: params.userId,
    repoLink,
    baseEnrichment,
  });

  // Phase 2.7: pure scoring pass over the regressions list to pick the
  // most-likely culprit. Runs in-process (no I/O), so it's safe to apply
  // unconditionally — it just no-ops when there are no regressions or no
  // candidate clears the medium threshold.
  return applyCulpritDetection({
    enrichment: blameEnriched,
    input: params.input,
  });
}

/// Pure scoring layer (Phase 2.7) that picks the most-likely-culprit
/// commit from `enrichment.suspectedRegressions` by cross-referencing the
/// LLM's affectedArea / probableRootCause / summary against each commit's
/// message + touched files. Always synchronous from a network perspective
/// — runs in-process against data already loaded.
function applyCulpritDetection(params: {
  enrichment: RepoEnrichmentInput;
  input: HandoffPacketInput;
}): RepoEnrichmentInput {
  const { enrichment, input } = params;
  // No regressions → no culprit. Cheap exit before any tokenization.
  if (
    !enrichment.suspectedRegressions ||
    enrichment.suspectedRegressions.length === 0
  ) {
    return enrichment;
  }

  try {
    const result = detectLikelyCulpritFromEnrichment(enrichment, {
      affectedArea: input.diagnosis.affectedArea,
      probableRootCause: input.diagnosis.probableRootCause,
      summary: input.diagnosis.summary,
      // Phase 2.8: contradictions feed the negative-evidence layer.
      // They trigger scope-exclusion penalties ("Only on iOS" → demote
      // android-only commits) and nudge the confidence cap to medium.
      contradictions: input.diagnosis.contradictions,
    });
    if (process.env.NODE_ENV !== "production") {
      console.info(`${LOG_PREFIX} culprit detection`, {
        topScore: result.topScore,
        picked: result.culprit?.sha ?? null,
        confidence: result.culprit?.confidence ?? null,
        runnerUp: result.runnerUpSha,
      });
    }
    if (!result.culprit) return enrichment;
    return { ...enrichment, likelyCulprit: result.culprit };
  } catch (error) {
    // Pure scoring shouldn't throw, but a defensive try/catch keeps the
    // packet shipping if a future change introduces a bug here.
    console.warn(`${LOG_PREFIX} culprit detection threw`, error);
    return enrichment;
  }
}

async function applyBlameEnrichment(params: {
  userId: string;
  repoLink: PickedRepoLink["repoLink"];
  baseEnrichment: RepoEnrichmentInput;
}): Promise<RepoEnrichmentInput> {
  const { userId, repoLink, baseEnrichment } = params;

  // Short-circuit: if no resolved locations, there's nothing to blame.
  const hasLocations =
    baseEnrichment.affectedAreaLocation !== undefined ||
    (baseEnrichment.stackLocations?.length ?? 0) > 0 ||
    Object.keys(baseEnrichment.evidenceLocations ?? {}).length > 0;
  if (!hasLocations) return baseEnrichment;

  // Token lookup can fail (user revoked access between snapshot + handoff).
  // Treat that identically to "no connected account" — ship unenriched.
  let token: string | null = null;
  try {
    token = await getDecryptedAccessToken(userId);
  } catch (error) {
    console.warn(`${LOG_PREFIX} token lookup failed`, error);
  }
  if (!token) return baseEnrichment;

  const ctx = buildBlameContext({ token, repoLink });

  try {
    const result = await enrichBlame(baseEnrichment, ctx);
    if (process.env.NODE_ENV !== "production") {
      console.info(`${LOG_PREFIX} blame enrichment ok`, {
        filesQueried: result.filesQueried.length,
        locationsBlamed: result.locationsBlamed,
        suspectedRegressions:
          result.enrichment.suspectedRegressions?.length ?? 0,
      });
    }
    return result.enrichment;
  } catch (error) {
    // Defensive: `enrichBlame` swallows per-file errors internally, but any
    // bug at the orchestration layer (e.g. bad token shape) must not take
    // handoff down.
    console.warn(`${LOG_PREFIX} blame enrichment threw`, error);
    return baseEnrichment;
  }
}

/// Builds a `BlameContext` that:
///   - resolves per-line blame via GitHub's GraphQL `blame` endpoint
///     (Phase 2.6) — different lines on the same file get distinct
///     attribution. The full file's blame ranges come back in one query
///     and are cached in-process, so multiple lines on the same file
///     reuse a single network call.
///   - falls back to file-level blame (most-recent commit on the file)
///     when a `RepoLocation` has no `line`, or when no range covers the
///     requested line (e.g. the snapshot drifted from the live ref).
///   - aggregates suspected regressions via REST list-commits, cached
///     per-file (multiple locations on the same file → one API call).
///   - enforces a hard file budget (`BLAME_FILE_BUDGET`) on each query
///     family independently — a packet with 8 distinct files will issue
///     up to 8 GraphQL blame calls AND 8 REST list-commits calls, capped.
///   - enforces a per-call concurrency cap (`BLAME_CONCURRENCY`).
///   - enforces a per-call timeout (`BLAME_FETCH_TIMEOUT_MS`) via
///     AbortController so a single slow file doesn't block the handoff.
function buildBlameContext(params: {
  token: string;
  repoLink: PickedRepoLink["repoLink"];
}): BlameContext {
  const { token, repoLink } = params;

  const blameRangesCache = new Map<string, Promise<GithubBlameResult>>();
  const recentCommitsCache = new Map<string, Promise<BlameCommit[]>>();
  let blameBudgetRemaining = BLAME_FILE_BUDGET;
  let recentBudgetRemaining = BLAME_FILE_BUDGET;

  let inFlight = 0;
  const waiters: Array<() => void> = [];

  async function acquireSlot(): Promise<void> {
    if (inFlight < BLAME_CONCURRENCY) {
      inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight += 1;
  }

  function releaseSlot(): void {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  async function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
    await acquireSlot();
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        BLAME_FETCH_TIMEOUT_MS
      );
      try {
        return await fn();
      } finally {
        clearTimeout(timer);
      }
    } finally {
      releaseSlot();
    }
  }

  async function fetchBlameRanges(path: string): Promise<GithubBlameResult> {
    return withTimeout(async () => {
      try {
        return await getFileBlameRanges(
          token,
          repoLink.ownerLogin,
          repoLink.repoName,
          repoLink.latestSnapshotCommitSha,
          path
        );
      } catch (error) {
        if (error instanceof GithubApiError && error.status === 404) {
          return { ranges: [], mostRecentCommit: null };
        }
        throw error;
      }
    });
  }

  async function fetchRecentCommits(path: string): Promise<BlameCommit[]> {
    return withTimeout(async () => {
      try {
        const commits = await listCommitsForPath(
          token,
          repoLink.ownerLogin,
          repoLink.repoName,
          path,
          {
            ref: repoLink.latestSnapshotCommitSha,
            perPage: BLAME_COMMITS_PER_FILE,
          }
        );
        return commits.map(toBlameCommit);
      } catch (error) {
        if (error instanceof GithubApiError && error.status === 404) {
          return [];
        }
        throw error;
      }
    });
  }

  function getBlameRanges(file: string): Promise<GithubBlameResult> {
    const cached = blameRangesCache.get(file);
    if (cached) return cached;
    if (blameBudgetRemaining <= 0) {
      const empty: GithubBlameResult = { ranges: [], mostRecentCommit: null };
      const promise = Promise.resolve(empty);
      blameRangesCache.set(file, promise);
      return promise;
    }
    blameBudgetRemaining -= 1;
    const promise = fetchBlameRanges(file);
    blameRangesCache.set(file, promise);
    return promise;
  }

  return {
    resolveLineBlame: async (file, line) => {
      const ranges = await getBlameRanges(file);
      // When the location has a line, look up the range that covers it.
      // GraphQL blame ranges are contiguous and sorted, so a linear scan is
      // fine for the small N (a few dozen ranges per file at most).
      if (line !== undefined) {
        const range = ranges.ranges.find(
          (r) => line >= r.startingLine && line <= r.endingLine
        );
        if (range) return toBlameCommit(range.commit);
      }
      // Path-only location, or line out of range → file-level fallback.
      return ranges.mostRecentCommit
        ? toBlameCommit(ranges.mostRecentCommit)
        : null;
    },
    listRecentCommits: (file) => {
      const cached = recentCommitsCache.get(file);
      if (cached) return cached;
      if (recentBudgetRemaining <= 0) {
        const empty = Promise.resolve<BlameCommit[]>([]);
        recentCommitsCache.set(file, empty);
        return empty;
      }
      recentBudgetRemaining -= 1;
      const promise = fetchRecentCommits(file);
      recentCommitsCache.set(file, promise);
      return promise;
    },
  };
}

function toBlameCommit(c: GithubCommitSummary): BlameCommit {
  return {
    sha: c.sha,
    message: c.message,
    authorLogin: c.authorLogin,
    authorName: c.authorName,
    date: c.date,
    htmlUrl: c.htmlUrl,
  };
}

// ---------------------------------------------------------------------------
// Repo link resolution
// ---------------------------------------------------------------------------

type PickedRepoLink = {
  repoLink: {
    id: string;
    workspaceId: string;
    ownerLogin: string;
    repoName: string;
    latestSnapshotCommitSha: string;
  };
  snapshotId: string | null;
};

/// "One repo per case" policy:
///   1. `case.repoLinkId` is the explicit pick — use it.
///   2. If the case hasn't been scoped yet and the workspace has exactly
///      one linked repo, scope to that.
///   3. Otherwise, no enrichment.
///
/// Access is already enforced upstream by `loadCaseForHandoff`, so here we
/// trust the caller's `caseId`.
async function pickRepoLinkForCase(
  userId: string,
  caseId: string
): Promise<PickedRepoLink | null> {
  const caseRow = await prisma.targCase.findUnique({
    where: { id: caseId },
    select: {
      workspaceId: true,
      repoLinkId: true,
    },
  });
  if (!caseRow) return null;

  // Prefer the case-scoped repo link, if set.
  if (caseRow.repoLinkId) {
    const link = await loadRepoLinkDetails(caseRow.repoLinkId);
    if (link) return link;
  }

  // Fallback: if the workspace has exactly one linked repo, use it.
  const workspaceLinks = await prisma.targRepoLink.findMany({
    where: { workspaceId: caseRow.workspaceId },
    select: { id: true },
    take: 2,
  });
  if (workspaceLinks.length === 1) {
    const link = await loadRepoLinkDetails(workspaceLinks[0].id);
    if (link) return link;
  }

  // User is a member (access was already checked upstream), but we note
  // unused userId for lint; surface it here if we later need per-user
  // membership checks at this layer.
  void userId;
  return null;
}

async function loadRepoLinkDetails(
  repoLinkId: string
): Promise<PickedRepoLink | null> {
  const link = await prisma.targRepoLink.findUnique({
    where: { id: repoLinkId },
    select: {
      id: true,
      workspaceId: true,
      ownerLogin: true,
      repoName: true,
      latestSnapshot: {
        select: { id: true, commitSha: true },
      },
    },
  });
  if (!link) return null;

  return {
    repoLink: {
      id: link.id,
      workspaceId: link.workspaceId,
      ownerLogin: link.ownerLogin,
      repoName: link.repoName,
      latestSnapshotCommitSha: link.latestSnapshot?.commitSha ?? "",
    },
    snapshotId: link.latestSnapshot?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot data loading
// ---------------------------------------------------------------------------

async function loadFilesForSnapshot(
  snapshotId: string
): Promise<ResolverInputFile[]> {
  const rows = await prisma.targRepoFile.findMany({
    where: { snapshotId },
    select: { path: true, kind: true, language: true },
  });
  return rows.map((row) => ({
    path: row.path,
    kind: row.kind as RepoFileKind,
    language: row.language,
  }));
}

async function loadSymbolsForSnapshot(
  snapshotId: string
): Promise<ResolverInputSymbol[]> {
  const rows = await prisma.targRepoSymbol.findMany({
    where: { snapshotId },
    select: {
      name: true,
      kind: true,
      line: true,
      endLine: true,
      exported: true,
      file: {
        select: { path: true, kind: true, language: true },
      },
    },
  });
  return rows.map((row) => ({
    name: row.name,
    kind: row.kind as RepoSymbolKind,
    line: row.line,
    endLine: row.endLine,
    exported: row.exported,
    filePath: row.file.path,
    fileKind: row.file.kind as RepoFileKind,
    fileLanguage: row.file.language,
  }));
}

// ---------------------------------------------------------------------------
// Background sync
// ---------------------------------------------------------------------------

type BackgroundSyncInput = {
  userId: string;
  workspaceId: string;
  repoLinkId: string;
  reason: "no_snapshot" | "stale_snapshot";
};

/// Fires a `syncRepoTree` call without awaiting it. The sync runs in the
/// same Node process (no queue yet — see Phase 2.4+), so on Vercel-style
/// serverless deploys it may get killed when the HTTP response closes.
/// That's acceptable for now: the worst case is the next handoff triggers
/// another background sync. On long-running hosts (local dev, Fly, Render)
/// it completes normally and the next handoff benefits.
function triggerBackgroundSync(input: BackgroundSyncInput): void {
  // Dev-only debug log — noise in production, useful during integration.
  if (process.env.NODE_ENV !== "production") {
    console.info(
      `${LOG_PREFIX} background sync triggered (${input.reason})`,
      { workspaceId: input.workspaceId, repoLinkId: input.repoLinkId }
    );
  }

  void syncRepoTree({
    userId: input.userId,
    workspaceId: input.workspaceId,
    repoLinkId: input.repoLinkId,
    reuseExisting: true,
    includeSymbols: true,
  })
    .then((summary) => {
      if (process.env.NODE_ENV !== "production") {
        console.info(`${LOG_PREFIX} background sync ok`, {
          snapshotId: summary.id,
          status: summary.status,
        });
      }
    })
    .catch((error) => {
      // Expected: github_not_connected, workspace_access_denied, rate limits,
      // etc. None of these should surface as user-visible errors — the
      // handoff already succeeded by the time we're here.
      console.warn(`${LOG_PREFIX} background sync failed`, {
        reason: input.reason,
        repoLinkId: input.repoLinkId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
