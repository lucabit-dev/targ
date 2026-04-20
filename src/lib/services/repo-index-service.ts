/// Repo indexing service (Phase 2.2).
///
/// Responsibility: given a TargRepoLink, produce a TargRepoSnapshot that
/// captures the repo's file tree (and, in 2.2e, its symbols) at a pinned
/// commit SHA. This is the source of truth the resolver consults when
/// translating evidence hints into real repo paths / line numbers.
///
/// The service is split into phases so we can commit tree data and make the
/// UI usable while symbol indexing — which is meaningfully slower — is still
/// running or deferred:
///
///   syncRepoTree   -> TargRepoSnapshot + TargRepoFile rows (Phase 2.2b)
///   syncRepoSymbols (future, 2.2e) -> TargRepoSymbol rows, flips `symbolSyncedAt`

import type { RepoSnapshotStatus } from "@prisma/client";

import {
  getCommitSha,
  getTreeRecursive,
  GithubApiError,
  type GithubTreeEntry,
} from "@/lib/github/client";
import { prisma } from "@/lib/prisma";
import { classifyFilePath } from "@/lib/repo-index/classify";
import { getDecryptedAccessToken } from "@/lib/services/github-account-service";

/// Hard cap on files we persist per snapshot. A repo with more than this is
/// almost certainly a monorepo / data dump; we still produce a snapshot, but
/// mark it PARTIAL so the UI can warn that resolution accuracy will suffer.
const MAX_FILES_PER_SNAPSHOT = 20_000;

/// Prisma's SQLite driver handles batch inserts well up to a few thousand
/// rows; we chunk to stay comfortably below the default statement limits.
const FILE_INSERT_CHUNK_SIZE = 1000;

/// How long a READY snapshot is considered fresh. Lazy-resync callers use
/// this to decide whether to trigger an on-demand tree refresh.
export const SNAPSHOT_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export class RepoIndexError extends Error {
  readonly code: RepoIndexErrorCode;

  constructor(code: RepoIndexErrorCode, message: string) {
    super(message);
    this.name = "RepoIndexError";
    this.code = code;
  }
}

export type RepoIndexErrorCode =
  | "repo_link_not_found"
  | "workspace_access_denied"
  | "github_not_connected"
  | "github_access_denied"
  | "repo_not_found"
  | "branch_not_found"
  | "sync_failed";

export type RepoSnapshotSummary = {
  id: string;
  repoLinkId: string;
  commitSha: string;
  branch: string;
  status: RepoSnapshotStatus;
  statusDetail: string | null;
  treeSyncedAt: Date | null;
  symbolSyncedAt: Date | null;
  fileCount: number;
  symbolCount: number;
  createdAt: Date;
  updatedAt: Date;
  /// True when the snapshot was reused (no new tree fetch) because a recent
  /// READY snapshot already existed at the current HEAD SHA.
  reusedExistingSnapshot: boolean;
};

async function assertUserCanAccessRepoLink(params: {
  userId: string;
  workspaceId: string;
  repoLinkId: string;
}): Promise<{
  id: string;
  ownerLogin: string;
  repoName: string;
  defaultBranch: string;
  latestSnapshotId: string | null;
}> {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId: params.userId, workspaceId: params.workspaceId },
    select: { id: true },
  });
  if (!membership) {
    throw new RepoIndexError(
      "workspace_access_denied",
      "Workspace not found or you do not have access."
    );
  }

  const repoLink = await prisma.targRepoLink.findFirst({
    where: { id: params.repoLinkId, workspaceId: params.workspaceId },
    select: {
      id: true,
      ownerLogin: true,
      repoName: true,
      defaultBranch: true,
      latestSnapshotId: true,
    },
  });
  if (!repoLink) {
    throw new RepoIndexError(
      "repo_link_not_found",
      "That repository link no longer exists."
    );
  }
  return repoLink;
}

function mapGithubError(
  error: unknown,
  context: { owner: string; name: string; ref?: string }
): RepoIndexError {
  if (error instanceof GithubApiError) {
    if (error.status === 404) {
      if (context.ref) {
        return new RepoIndexError(
          "branch_not_found",
          `Branch "${context.ref}" was not found in ${context.owner}/${context.name}.`
        );
      }
      return new RepoIndexError(
        "repo_not_found",
        `Repository ${context.owner}/${context.name} was not found, or your GitHub account cannot see it.`
      );
    }
    if (error.status === 401 || error.status === 403) {
      return new RepoIndexError(
        "github_access_denied",
        "Your GitHub token was rejected. Reconnect GitHub and try again."
      );
    }
  }
  return new RepoIndexError(
    "sync_failed",
    error instanceof Error ? error.message : "Repo sync failed."
  );
}

function toSummary(
  snapshot: {
    id: string;
    repoLinkId: string;
    commitSha: string;
    branch: string;
    status: RepoSnapshotStatus;
    statusDetail: string | null;
    treeSyncedAt: Date | null;
    symbolSyncedAt: Date | null;
    fileCount: number;
    symbolCount: number;
    createdAt: Date;
    updatedAt: Date;
  },
  reusedExistingSnapshot: boolean
): RepoSnapshotSummary {
  return { ...snapshot, reusedExistingSnapshot };
}

export type SyncRepoTreeInput = {
  userId: string;
  workspaceId: string;
  repoLinkId: string;
  /// If true, reuse an existing READY snapshot when the HEAD SHA matches.
  /// Default true. Callers that want to force a fresh tree read (e.g. the
  /// "Re-sync" button) can pass false.
  reuseExisting?: boolean;
};

/// Builds a tree-only TargRepoSnapshot for the given TargRepoLink. Idempotent:
/// if a READY snapshot already exists at the current HEAD SHA, returns that
/// snapshot without re-reading the tree.
export async function syncRepoTree(
  input: SyncRepoTreeInput
): Promise<RepoSnapshotSummary> {
  const reuseExisting = input.reuseExisting ?? true;
  const repoLink = await assertUserCanAccessRepoLink(input);

  const token = await getDecryptedAccessToken(input.userId);
  if (!token) {
    throw new RepoIndexError(
      "github_not_connected",
      "Connect your GitHub account before syncing a repository."
    );
  }

  let commitSha: string;
  try {
    commitSha = await getCommitSha(
      token,
      repoLink.ownerLogin,
      repoLink.repoName,
      repoLink.defaultBranch
    );
  } catch (error) {
    throw mapGithubError(error, {
      owner: repoLink.ownerLogin,
      name: repoLink.repoName,
      ref: repoLink.defaultBranch,
    });
  }

  if (reuseExisting) {
    const existing = await prisma.targRepoSnapshot.findUnique({
      where: {
        repoLinkId_commitSha: { repoLinkId: repoLink.id, commitSha },
      },
      select: {
        id: true,
        repoLinkId: true,
        commitSha: true,
        branch: true,
        status: true,
        statusDetail: true,
        treeSyncedAt: true,
        symbolSyncedAt: true,
        fileCount: true,
        symbolCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (
      existing &&
      (existing.status === "READY" || existing.status === "PARTIAL") &&
      existing.treeSyncedAt
    ) {
      await prisma.targRepoLink.update({
        where: { id: repoLink.id },
        data: { latestSnapshotId: existing.id, lastSyncedAt: new Date() },
      });
      return toSummary(existing, true);
    }
  }

  const snapshot = await prisma.targRepoSnapshot.upsert({
    where: {
      repoLinkId_commitSha: { repoLinkId: repoLink.id, commitSha },
    },
    create: {
      repoLinkId: repoLink.id,
      commitSha,
      branch: repoLink.defaultBranch,
      status: "SYNCING",
    },
    update: {
      status: "SYNCING",
      statusDetail: null,
      treeSyncedAt: null,
      symbolSyncedAt: null,
      fileCount: 0,
      symbolCount: 0,
    },
    select: { id: true },
  });

  try {
    const tree = await getTreeRecursive(
      token,
      repoLink.ownerLogin,
      repoLink.repoName,
      commitSha
    );

    const blobs = tree.entries.filter((entry) => entry.type === "blob");
    const truncatedByCap = blobs.length > MAX_FILES_PER_SNAPSHOT;
    const capped = truncatedByCap ? blobs.slice(0, MAX_FILES_PER_SNAPSHOT) : blobs;

    await prisma.targRepoFile.deleteMany({
      where: { snapshotId: snapshot.id },
    });

    for (let i = 0; i < capped.length; i += FILE_INSERT_CHUNK_SIZE) {
      const chunk = capped.slice(i, i + FILE_INSERT_CHUNK_SIZE);
      await prisma.targRepoFile.createMany({
        data: chunk.map(fileRowFromTreeEntry(snapshot.id)),
      });
    }

    const partialReasons: string[] = [];
    if (tree.truncated) {
      partialReasons.push("GitHub tree API marked the response truncated.");
    }
    if (truncatedByCap) {
      partialReasons.push(
        `Only the first ${MAX_FILES_PER_SNAPSHOT} files were indexed (repo has ${blobs.length}).`
      );
    }
    const isPartial = partialReasons.length > 0;

    const updated = await prisma.targRepoSnapshot.update({
      where: { id: snapshot.id },
      data: {
        status: isPartial ? "PARTIAL" : "READY",
        statusDetail: isPartial ? partialReasons.join(" ") : null,
        treeSyncedAt: new Date(),
        fileCount: capped.length,
      },
      select: {
        id: true,
        repoLinkId: true,
        commitSha: true,
        branch: true,
        status: true,
        statusDetail: true,
        treeSyncedAt: true,
        symbolSyncedAt: true,
        fileCount: true,
        symbolCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await prisma.targRepoLink.update({
      where: { id: repoLink.id },
      data: { latestSnapshotId: updated.id, lastSyncedAt: new Date() },
    });

    return toSummary(updated, false);
  } catch (error) {
    await prisma.targRepoSnapshot.update({
      where: { id: snapshot.id },
      data: {
        status: "FAILED",
        statusDetail:
          error instanceof Error ? error.message : "Unknown sync failure.",
      },
    });
    throw mapGithubError(error, {
      owner: repoLink.ownerLogin,
      name: repoLink.repoName,
    });
  }
}

function fileRowFromTreeEntry(snapshotId: string) {
  return (entry: GithubTreeEntry) => {
    const { kind, language } = classifyFilePath(entry.path);
    return {
      snapshotId,
      path: entry.path,
      size: entry.size ?? 0,
      blobSha: entry.sha,
      kind,
      language,
    };
  };
}

/// Returns true when the link's latest snapshot is either missing or older
/// than SNAPSHOT_FRESHNESS_MS. Used by lazy-sync callers.
export async function isRepoSnapshotStale(repoLinkId: string): Promise<boolean> {
  const link = await prisma.targRepoLink.findUnique({
    where: { id: repoLinkId },
    select: {
      latestSnapshot: {
        select: { status: true, treeSyncedAt: true },
      },
    },
  });
  if (!link || !link.latestSnapshot) {
    return true;
  }
  const { status, treeSyncedAt } = link.latestSnapshot;
  if (status === "FAILED" || !treeSyncedAt) {
    return true;
  }
  return Date.now() - treeSyncedAt.getTime() > SNAPSHOT_FRESHNESS_MS;
}

/// Returns latest-snapshot summaries for every repo link in a workspace, keyed
/// by repoLinkId. Used by the repo-listing API so the UI can render sync chips
/// in the same payload as the link rows.
export async function listLatestSnapshotsByWorkspace(
  workspaceId: string
): Promise<Record<string, RepoSnapshotSummary>> {
  const links = await prisma.targRepoLink.findMany({
    where: { workspaceId, latestSnapshotId: { not: null } },
    select: {
      id: true,
      latestSnapshot: {
        select: {
          id: true,
          repoLinkId: true,
          commitSha: true,
          branch: true,
          status: true,
          statusDetail: true,
          treeSyncedAt: true,
          symbolSyncedAt: true,
          fileCount: true,
          symbolCount: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  const result: Record<string, RepoSnapshotSummary> = {};
  for (const link of links) {
    if (link.latestSnapshot) {
      result[link.id] = toSummary(link.latestSnapshot, true);
    }
  }
  return result;
}

export async function getLatestSnapshotSummary(
  repoLinkId: string
): Promise<RepoSnapshotSummary | null> {
  const link = await prisma.targRepoLink.findUnique({
    where: { id: repoLinkId },
    select: {
      latestSnapshot: {
        select: {
          id: true,
          repoLinkId: true,
          commitSha: true,
          branch: true,
          status: true,
          statusDetail: true,
          treeSyncedAt: true,
          symbolSyncedAt: true,
          fileCount: true,
          symbolCount: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!link || !link.latestSnapshot) {
    return null;
  }
  return toSummary(link.latestSnapshot, true);
}
