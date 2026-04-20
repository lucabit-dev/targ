import { Prisma } from "@prisma/client";
import { compare, hash } from "bcryptjs";

import { prisma } from "@/lib/prisma";
import type { LoginInput, SignupInput } from "@/lib/validators";

function buildPersonalWorkspaceName(name: string, email: string) {
  const trimmedName = name.trim();

  if (trimmedName.length > 0) {
    return `${trimmedName}'s Workspace`;
  }

  return `${email.split("@")[0]}'s Workspace`;
}

export async function signupUser(input: SignupInput) {
  const passwordHash = await hash(input.password, 10);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          name: input.name,
        },
      });

      const workspace = await tx.workspace.create({
        data: {
          name: buildPersonalWorkspaceName(input.name, input.email),
          personalForUserId: user.id,
        },
      });

      await tx.workspaceMembership.create({
        data: {
          userId: user.id,
          workspaceId: workspace.id,
          role: "OWNER",
        },
      });

      return { user, workspace };
    });

    return result;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error("An account already exists for that email.");
    }

    throw error;
  }
}

export async function loginUser(input: LoginInput) {
  const user = await prisma.user.findUnique({
    where: {
      email: input.email,
    },
  });

  if (!user) {
    return null;
  }

  const isValidPassword = await compare(input.password, user.passwordHash);

  if (!isValidPassword) {
    return null;
  }

  return user;
}

export async function getUserContext(userId: string) {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      memberships: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          role: true,
          workspace: {
            select: {
              id: true,
              name: true,
              personalForUserId: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    return null;
  }

  const workspaces = user.memberships.map((membership) => ({
    id: membership.workspace.id,
    name: membership.workspace.name,
    role: membership.role,
    personalForUserId: membership.workspace.personalForUserId,
    createdAt: membership.workspace.createdAt,
    updatedAt: membership.workspace.updatedAt,
  }));

  const currentWorkspace =
    workspaces.find((workspace) => workspace.personalForUserId === user.id) ??
    workspaces[0] ??
    null;

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    },
    workspaces,
    currentWorkspace,
  };
}
