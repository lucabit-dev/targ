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

import type { HandoffPacketInput, RepoEnrichmentInput } from "@/lib/handoff/packet";
import {
  enrichPacketInput,
  type EnrichmentContext,
} from "@/lib/handoff/repo-enrichment";
import { prisma } from "@/lib/prisma";
import {
  resolvePath,
  resolveSymbol,
  type ResolverInputFile,
  type ResolverInputSymbol,
} from "@/lib/repo-index/resolver";
import {
  isRepoSnapshotStale,
  syncRepoTree,
} from "@/lib/services/repo-index-service";

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

  try {
    return enrichPacketInput(params.input, ctx);
  } catch (error) {
    // Enrichment is best-effort — never let a bug here take out handoff.
    console.warn(`${LOG_PREFIX} enrichPacketInput threw`, error);
    return undefined;
  }
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
