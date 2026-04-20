import { prisma } from "@/lib/prisma";
import type { CreateWorkspaceInput } from "@/lib/validators";
import {
  parseWorkspacePlaybook,
  type WorkspacePlaybook,
} from "@/lib/workspace/playbook";

export async function listWorkspacesForUser(userId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: {
      userId,
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      role: true,
      workspace: {
        select: {
          id: true,
          name: true,
          personalForUserId: true,
          playbookConfig: true,
          playbookConfiguredAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  return memberships.map((membership) => ({
    id: membership.workspace.id,
    name: membership.workspace.name,
    role: membership.role,
    personalForUserId: membership.workspace.personalForUserId,
    playbook: parseWorkspacePlaybook(membership.workspace.playbookConfig),
    playbookConfiguredAt: membership.workspace.playbookConfiguredAt,
    createdAt: membership.workspace.createdAt,
    updatedAt: membership.workspace.updatedAt,
  }));
}

export async function createWorkspaceForUser(
  userId: string,
  input: CreateWorkspaceInput
) {
  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: input.name,
      },
    });

    await tx.workspaceMembership.create({
      data: {
        userId,
        workspaceId: workspace.id,
        role: "OWNER",
      },
    });

    return workspace;
  });
}

export async function getWorkspaceForUser(userId: string, workspaceId: string) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: {
      userId,
      workspaceId,
    },
    select: {
      role: true,
      workspace: {
        select: {
          id: true,
          name: true,
          personalForUserId: true,
          playbookConfig: true,
          playbookConfiguredAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!membership) {
    return null;
  }

  return {
    id: membership.workspace.id,
    name: membership.workspace.name,
    role: membership.role,
    personalForUserId: membership.workspace.personalForUserId,
    playbook: parseWorkspacePlaybook(membership.workspace.playbookConfig),
    playbookConfiguredAt: membership.workspace.playbookConfiguredAt,
    createdAt: membership.workspace.createdAt,
    updatedAt: membership.workspace.updatedAt,
  };
}

export async function updateWorkspacePlaybookForUser(
  userId: string,
  workspaceId: string,
  playbook: WorkspacePlaybook
) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: {
      userId,
      workspaceId,
    },
    select: {
      workspaceId: true,
    },
  });

  if (!membership) {
    throw new Error("Workspace not found.");
  }

  const updated = await prisma.workspace.update({
    where: {
      id: workspaceId,
    },
    data: {
      playbookConfig: playbook,
      playbookConfiguredAt: new Date(),
    },
    select: {
      id: true,
      name: true,
      personalForUserId: true,
      playbookConfig: true,
      playbookConfiguredAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    id: updated.id,
    name: updated.name,
    personalForUserId: updated.personalForUserId,
    playbook: parseWorkspacePlaybook(updated.playbookConfig),
    playbookConfiguredAt: updated.playbookConfiguredAt,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}
