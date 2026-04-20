import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => {
  return {
    prisma: {
      workspaceMembership: { findFirst: vi.fn() },
      targRepoLink: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
    },
  };
});

vi.mock("@/lib/github/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github/client")>(
    "@/lib/github/client"
  );
  return {
    ...actual,
    getRepo: vi.fn(),
  };
});

vi.mock("@/lib/services/github-account-service", () => ({
  getDecryptedAccessToken: vi.fn(),
}));

import { Prisma } from "@prisma/client";

import { getRepo, GithubApiError } from "@/lib/github/client";
import { prisma } from "@/lib/prisma";
import { getDecryptedAccessToken } from "@/lib/services/github-account-service";

import {
  connectRepoToWorkspace,
  disconnectRepoFromWorkspace,
  listRepoLinksForWorkspace,
  RepoLinkError,
} from "./repo-link-service";

const membershipFindFirst = prisma.workspaceMembership.findFirst as unknown as ReturnType<typeof vi.fn>;
const repoLinkFindMany = prisma.targRepoLink.findMany as unknown as ReturnType<typeof vi.fn>;
const repoLinkFindFirst = prisma.targRepoLink.findFirst as unknown as ReturnType<typeof vi.fn>;
const repoLinkCreate = prisma.targRepoLink.create as unknown as ReturnType<typeof vi.fn>;
const repoLinkDelete = prisma.targRepoLink.delete as unknown as ReturnType<typeof vi.fn>;
const getRepoMock = getRepo as unknown as ReturnType<typeof vi.fn>;
const getDecryptedAccessTokenMock = getDecryptedAccessToken as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

function existingMembership() {
  membershipFindFirst.mockResolvedValueOnce({ id: "mem-1" });
}

function missingMembership() {
  membershipFindFirst.mockResolvedValueOnce(null);
}

function sampleRepoRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rlink-1",
    workspaceId: "ws-1",
    connectedByUserId: "user-1",
    provider: "GITHUB",
    githubRepoId: 10,
    ownerLogin: "octo",
    repoName: "hello",
    defaultBranch: "main",
    remoteUrl: "https://github.com/octo/hello",
    visibility: "PUBLIC",
    lastSyncedAt: new Date("2024-05-01T00:00:00Z"),
    createdAt: new Date("2024-05-01T00:00:00Z"),
    updatedAt: new Date("2024-05-01T00:00:00Z"),
    ...overrides,
  };
}

describe("repo-link-service", () => {
  describe("listRepoLinksForWorkspace", () => {
    it("rejects when the user is not a member of the workspace", async () => {
      missingMembership();

      await expect(
        listRepoLinksForWorkspace({ userId: "user-1", workspaceId: "ws-1" })
      ).rejects.toBeInstanceOf(RepoLinkError);
      expect(repoLinkFindMany).not.toHaveBeenCalled();
    });

    it("returns summaries with a combined fullName", async () => {
      existingMembership();
      repoLinkFindMany.mockResolvedValueOnce([sampleRepoRow()]);

      const result = await listRepoLinksForWorkspace({
        userId: "user-1",
        workspaceId: "ws-1",
      });

      expect(result).toHaveLength(1);
      expect(result[0].fullName).toBe("octo/hello");
      expect(result[0].visibility).toBe("PUBLIC");
    });
  });

  describe("connectRepoToWorkspace", () => {
    const baseInput = {
      userId: "user-1",
      workspaceId: "ws-1",
      owner: "octo",
      name: "hello",
    };

    it("requires a connected GitHub account", async () => {
      existingMembership();
      getDecryptedAccessTokenMock.mockResolvedValueOnce(null);

      await expect(connectRepoToWorkspace(baseInput)).rejects.toMatchObject({
        code: "github_not_connected",
      });
    });

    it("maps 404 from GitHub to repo_not_found", async () => {
      existingMembership();
      getDecryptedAccessTokenMock.mockResolvedValueOnce("tok");
      getRepoMock.mockRejectedValueOnce(new GithubApiError(404, "Not Found"));

      await expect(connectRepoToWorkspace(baseInput)).rejects.toMatchObject({
        code: "repo_not_found",
      });
    });

    it("maps 401 from GitHub to github_access_denied", async () => {
      existingMembership();
      getDecryptedAccessTokenMock.mockResolvedValueOnce("tok");
      getRepoMock.mockRejectedValueOnce(new GithubApiError(401, "Unauthorized"));

      await expect(connectRepoToWorkspace(baseInput)).rejects.toMatchObject({
        code: "github_access_denied",
      });
    });

    it("creates a repo link with normalised visibility", async () => {
      existingMembership();
      getDecryptedAccessTokenMock.mockResolvedValueOnce("tok");
      getRepoMock.mockResolvedValueOnce({
        id: 10,
        fullName: "octo/hello",
        owner: "octo",
        name: "hello",
        defaultBranch: "main",
        visibility: "private",
        description: null,
        htmlUrl: "https://github.com/octo/hello",
        cloneUrl: "https://github.com/octo/hello.git",
        pushedAt: null,
        updatedAt: null,
        archived: false,
        permissions: { admin: true, push: true, pull: true },
      });
      repoLinkCreate.mockResolvedValueOnce(
        sampleRepoRow({ visibility: "PRIVATE" })
      );

      const result = await connectRepoToWorkspace(baseInput);

      expect(result.visibility).toBe("PRIVATE");
      expect(repoLinkCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: "ws-1",
            connectedByUserId: "user-1",
            githubRepoId: 10,
            ownerLogin: "octo",
            repoName: "hello",
            visibility: "PRIVATE",
          }),
        })
      );
    });

    it("translates unique-constraint violations into already_linked", async () => {
      existingMembership();
      getDecryptedAccessTokenMock.mockResolvedValueOnce("tok");
      getRepoMock.mockResolvedValueOnce({
        id: 10,
        fullName: "octo/hello",
        owner: "octo",
        name: "hello",
        defaultBranch: "main",
        visibility: "public",
        description: null,
        htmlUrl: "https://github.com/octo/hello",
        cloneUrl: "https://github.com/octo/hello.git",
        pushedAt: null,
        updatedAt: null,
        archived: false,
        permissions: { admin: false, push: false, pull: true },
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        { code: "P2002", clientVersion: "x", meta: { target: ["workspaceId", "githubRepoId"] } }
      );
      repoLinkCreate.mockRejectedValueOnce(p2002);

      await expect(connectRepoToWorkspace(baseInput)).rejects.toMatchObject({
        code: "already_linked",
      });
    });
  });

  describe("disconnectRepoFromWorkspace", () => {
    it("returns repo_not_found when the link doesn't belong to the workspace", async () => {
      existingMembership();
      repoLinkFindFirst.mockResolvedValueOnce(null);

      await expect(
        disconnectRepoFromWorkspace({
          userId: "user-1",
          workspaceId: "ws-1",
          repoLinkId: "rlink-x",
        })
      ).rejects.toMatchObject({ code: "repo_not_found" });
      expect(repoLinkDelete).not.toHaveBeenCalled();
    });

    it("deletes the link when present", async () => {
      existingMembership();
      repoLinkFindFirst.mockResolvedValueOnce({ id: "rlink-1" });
      repoLinkDelete.mockResolvedValueOnce(sampleRepoRow());

      await expect(
        disconnectRepoFromWorkspace({
          userId: "user-1",
          workspaceId: "ws-1",
          repoLinkId: "rlink-1",
        })
      ).resolves.toBeUndefined();
      expect(repoLinkDelete).toHaveBeenCalledWith({ where: { id: "rlink-1" } });
    });
  });
});
