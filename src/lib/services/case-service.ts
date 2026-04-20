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
    },
  });
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
