import type { RepoProvider, RepoVisibility } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { getRepo, GithubApiError } from "@/lib/github/client";
import { prisma } from "@/lib/prisma";
import { getDecryptedAccessToken } from "@/lib/services/github-account-service";

export type RepoLinkSummary = {
  id: string;
  workspaceId: string;
  connectedByUserId: string;
  provider: RepoProvider;
  githubRepoId: number;
  ownerLogin: string;
  repoName: string;
  fullName: string;
  defaultBranch: string;
  remoteUrl: string;
  visibility: RepoVisibility;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export class RepoLinkError extends Error {
  readonly code: RepoLinkErrorCode;

  constructor(code: RepoLinkErrorCode, message: string) {
    super(message);
    this.name = "RepoLinkError";
    this.code = code;
  }
}

export type RepoLinkErrorCode =
  | "workspace_not_found"
  | "github_not_connected"
  | "github_access_denied"
  | "repo_not_found"
  | "already_linked";

function toSummary(row: {
  id: string;
  workspaceId: string;
  connectedByUserId: string;
  provider: RepoProvider;
  githubRepoId: number;
  ownerLogin: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string;
  visibility: RepoVisibility;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): RepoLinkSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    connectedByUserId: row.connectedByUserId,
    provider: row.provider,
    githubRepoId: row.githubRepoId,
    ownerLogin: row.ownerLogin,
    repoName: row.repoName,
    fullName: `${row.ownerLogin}/${row.repoName}`,
    defaultBranch: row.defaultBranch,
    remoteUrl: row.remoteUrl,
    visibility: row.visibility,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertUserBelongsToWorkspace(
  userId: string,
  workspaceId: string
): Promise<void> {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId, workspaceId },
    select: { id: true },
  });
  if (!membership) {
    throw new RepoLinkError(
      "workspace_not_found",
      "Workspace not found or you do not have access."
    );
  }
}

function visibilityFromString(raw: string): RepoVisibility {
  switch (raw) {
    case "public":
      return "PUBLIC";
    case "private":
      return "PRIVATE";
    case "internal":
      return "INTERNAL";
    default:
      return "UNKNOWN";
  }
}

export async function listRepoLinksForWorkspace(params: {
  userId: string;
  workspaceId: string;
}): Promise<RepoLinkSummary[]> {
  await assertUserBelongsToWorkspace(params.userId, params.workspaceId);

  const rows = await prisma.targRepoLink.findMany({
    where: { workspaceId: params.workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      workspaceId: true,
      connectedByUserId: true,
      provider: true,
      githubRepoId: true,
      ownerLogin: true,
      repoName: true,
      defaultBranch: true,
      remoteUrl: true,
      visibility: true,
      lastSyncedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map(toSummary);
}

export type ConnectRepoInput = {
  userId: string;
  workspaceId: string;
  owner: string;
  name: string;
};

/// Validates that the acting user can see the requested repo (via their stored
/// GitHub token) and creates a TargRepoLink on the workspace. Idempotent on
/// (workspaceId, githubRepoId): a duplicate throws `already_linked`.
export async function connectRepoToWorkspace(
  input: ConnectRepoInput
): Promise<RepoLinkSummary> {
  await assertUserBelongsToWorkspace(input.userId, input.workspaceId);

  const token = await getDecryptedAccessToken(input.userId);
  if (!token) {
    throw new RepoLinkError(
      "github_not_connected",
      "Connect your GitHub account before linking a repository."
    );
  }

  let repo;
  try {
    repo = await getRepo(token, input.owner, input.name);
  } catch (error) {
    if (error instanceof GithubApiError) {
      if (error.status === 404) {
        throw new RepoLinkError(
          "repo_not_found",
          `Repository ${input.owner}/${input.name} was not found, or your GitHub account cannot see it.`
        );
      }
      if (error.status === 401 || error.status === 403) {
        throw new RepoLinkError(
          "github_access_denied",
          "Your GitHub token was rejected. Reconnect GitHub and try again."
        );
      }
    }
    throw error;
  }

  try {
    const row = await prisma.targRepoLink.create({
      data: {
        workspaceId: input.workspaceId,
        connectedByUserId: input.userId,
        provider: "GITHUB",
        githubRepoId: repo.id,
        ownerLogin: repo.owner,
        repoName: repo.name,
        defaultBranch: repo.defaultBranch,
        remoteUrl: repo.htmlUrl,
        visibility: visibilityFromString(repo.visibility),
        lastSyncedAt: new Date(),
      },
      select: {
        id: true,
        workspaceId: true,
        connectedByUserId: true,
        provider: true,
        githubRepoId: true,
        ownerLogin: true,
        repoName: true,
        defaultBranch: true,
        remoteUrl: true,
        visibility: true,
        lastSyncedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return toSummary(row);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new RepoLinkError(
        "already_linked",
        `${repo.owner}/${repo.name} is already linked to this workspace.`
      );
    }
    throw error;
  }
}

export async function disconnectRepoFromWorkspace(params: {
  userId: string;
  workspaceId: string;
  repoLinkId: string;
}): Promise<void> {
  await assertUserBelongsToWorkspace(params.userId, params.workspaceId);

  const existing = await prisma.targRepoLink.findFirst({
    where: { id: params.repoLinkId, workspaceId: params.workspaceId },
    select: { id: true },
  });
  if (!existing) {
    throw new RepoLinkError(
      "repo_not_found",
      "That repository link no longer exists."
    );
  }

  await prisma.targRepoLink.delete({ where: { id: existing.id } });
}
