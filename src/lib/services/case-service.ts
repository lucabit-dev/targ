import { prisma } from "@/lib/prisma";
import {
  prismaProblemLensMap,
  prismaSolveModeMap,
} from "@/lib/planning/intake-preferences";
import type { CaseSolveMode } from "@prisma/client";

import type { CreateCaseInput } from "@/lib/validators";
import {
  deriveCaseDefaultsFromPlaybook,
  parseWorkspacePlaybook,
} from "@/lib/workspace/playbook";

function deriveCaseTitle(problemStatement: string) {
  const firstLine = problemStatement.split("\n")[0]?.trim() ?? "";
  const compact = firstLine.replace(/\s+/g, " ");

  if (!compact) {
    return "Untitled case";
  }

  return compact.slice(0, 80);
}

async function resolveWorkspaceForCase(userId: string, workspaceId?: string) {
  if (workspaceId) {
    const membership = await prisma.workspaceMembership.findFirst({
      where: {
        userId,
        workspaceId,
      },
      select: {
        workspaceId: true,
      },
    });

    return membership?.workspaceId ?? null;
  }

  const personalMembership = await prisma.workspaceMembership.findFirst({
    where: {
      userId,
      workspace: {
        personalForUserId: userId,
      },
    },
    select: {
      workspaceId: true,
    },
  });

  if (personalMembership) {
    return personalMembership.workspaceId;
  }

  const firstMembership = await prisma.workspaceMembership.findFirst({
    where: {
      userId,
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      workspaceId: true,
    },
  });

  return firstMembership?.workspaceId ?? null;
}

export async function createCaseForUser(userId: string, input: CreateCaseInput) {
  const workspaceId = await resolveWorkspaceForCase(userId, input.workspaceId);

  if (!workspaceId) {
    throw new Error("No workspace available for this user.");
  }

  const workspace = await prisma.workspace.findUnique({
    where: {
      id: workspaceId,
    },
    select: {
      playbookConfig: true,
    },
  });

  const workspacePlaybook = parseWorkspacePlaybook(workspace?.playbookConfig);
  const playbookDefaults = workspacePlaybook
    ? deriveCaseDefaultsFromPlaybook(workspacePlaybook)
    : null;
  const solveMode = input.solveMode ?? playbookDefaults?.solveMode ?? null;
  const problemLens =
    input.problemLens ?? playbookDefaults?.problemLens ?? null;

  return prisma.targCase.create({
    data: {
      workspaceId,
      title: input.title?.trim() || deriveCaseTitle(input.userProblemStatement),
      createdByUserId: userId,
      workflowState: "INTAKE",
      analysisState: "NOT_STARTED",
      draftState: "NOT_STARTED",
      userProblemStatement: input.userProblemStatement,
      evidenceVersion: 1,
      solveMode: solveMode ? (prismaSolveModeMap[solveMode] as never) : undefined,
      problemLens: problemLens
        ? (prismaProblemLensMap[problemLens] as never)
        : undefined,
    },
  });
}

export async function listCasesForUser(userId: string) {
  return prisma.targCase.findMany({
    where: {
      workspace: {
        memberships: {
          some: {
            userId,
          },
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      createdByUserId: true,
      workflowState: true,
      analysisState: true,
      draftState: true,
      userProblemStatement: true,
      severity: true,
      confidence: true,
      latestDiagnosisId: true,
      latestDraftId: true,
      evidenceVersion: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
      // Scope chip on the cases list (Phase 2.4). The relation is nullable —
      // most cases won't have a repo link yet.
      repoLink: {
        select: {
          ownerLogin: true,
          repoName: true,
        },
      },
      _count: {
        select: {
          evidence: true,
        },
      },
    },
  });
}

export async function getCaseForUser(userId: string, caseId: string) {
  return prisma.targCase.findFirst({
    where: {
      id: caseId,
      workspace: {
        memberships: {
          some: {
            userId,
          },
        },
      },
    },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      createdByUserId: true,
      workflowState: true,
      analysisState: true,
      draftState: true,
      userProblemStatement: true,
      problemLens: true,
      solveMode: true,
      severity: true,
      confidence: true,
      latestDiagnosisId: true,
      latestDraftId: true,
      evidenceVersion: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
      repoLinkId: true,
      repoLink: {
        select: {
          id: true,
          ownerLogin: true,
          repoName: true,
          defaultBranch: true,
          remoteUrl: true,
        },
      },
    },
  });
}

export class CaseServiceError extends Error {
  public readonly code: CaseServiceErrorCode;
  public readonly status: number;

  constructor(code: CaseServiceErrorCode, message: string, status: number) {
    super(message);
    this.name = "CaseServiceError";
    this.code = code;
    this.status = status;
  }
}

export type CaseServiceErrorCode =
  | "case_not_found"
  | "repo_link_not_found"
  | "repo_link_wrong_workspace";

export type CaseRepoLinkSummary = {
  id: string;
  ownerLogin: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
};

/// Sets (or clears, when `repoLinkId` is null) the repo a case is scoped to.
/// The Handoff enrichment layer reads this during packet construction to
/// decide which snapshot to resolve evidence hints against.
///
/// Authorization: the caller must be a member of the case's workspace (via
/// the shared `workspace.memberships` filter), and — when `repoLinkId` is
/// provided — that link must already belong to the same workspace. We do
/// NOT cross workspaces here; moving a repo between workspaces is out of
/// scope for case scoping.
export async function setCaseRepoLinkForUser(params: {
  userId: string;
  caseId: string;
  repoLinkId: string | null;
}): Promise<{ repoLinkId: string | null; repoLink: CaseRepoLinkSummary | null }> {
  const existing = await prisma.targCase.findFirst({
    where: {
      id: params.caseId,
      workspace: {
        memberships: { some: { userId: params.userId } },
      },
    },
    select: { id: true, workspaceId: true },
  });

  if (!existing) {
    throw new CaseServiceError(
      "case_not_found",
      "Case not found.",
      404
    );
  }

  if (params.repoLinkId !== null) {
    // Validate the repo link exists AND is in the same workspace. We do this
    // with a single query so we can give a precise error (not found vs wrong
    // workspace) for better UX.
    const link = await prisma.targRepoLink.findUnique({
      where: { id: params.repoLinkId },
      select: { id: true, workspaceId: true },
    });
    if (!link) {
      throw new CaseServiceError(
        "repo_link_not_found",
        "Repository link not found.",
        404
      );
    }
    if (link.workspaceId !== existing.workspaceId) {
      throw new CaseServiceError(
        "repo_link_wrong_workspace",
        "Repository link belongs to a different workspace.",
        403
      );
    }
  }

  const updated = await prisma.targCase.update({
    where: { id: params.caseId },
    data: { repoLinkId: params.repoLinkId },
    select: {
      repoLinkId: true,
      repoLink: {
        select: {
          id: true,
          ownerLogin: true,
          repoName: true,
          defaultBranch: true,
          remoteUrl: true,
        },
      },
    },
  });

  return {
    repoLinkId: updated.repoLinkId,
    repoLink: updated.repoLink ?? null,
  };
}

export async function updateCaseSolveModeForUser(
  userId: string,
  caseId: string,
  solveMode: CaseSolveMode
) {
  const existing = await prisma.targCase.findFirst({
    where: {
      id: caseId,
      workspace: {
        memberships: {
          some: { userId },
        },
      },
    },
    select: { id: true },
  });

  if (!existing) {
    return null;
  }

  return prisma.targCase.update({
    where: { id: caseId },
    data: { solveMode },
    select: {
      id: true,
      solveMode: true,
    },
  });
}

export async function listRecentCasesForUser(userId: string, limit = 5) {
  return prisma.targCase.findMany({
    where: {
      workspace: {
        memberships: {
          some: {
            userId,
          },
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    take: limit,
    select: {
      id: true,
      title: true,
      workflowState: true,
      analysisState: true,
      updatedAt: true,
      createdAt: true,
    },
  });
}
