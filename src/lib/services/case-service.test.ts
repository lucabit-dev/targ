/**
 * Tests for the subset of case-service that Phase 2.4 introduced —
 * `setCaseRepoLinkForUser`. Covers the authorization + scope rules that
 * determine whether a case can be pinned to a repo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    targCase: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    targRepoLink: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";

import {
  CaseServiceError,
  setCaseRepoLinkForUser,
} from "./case-service";

const caseFindFirst = prisma.targCase.findFirst as unknown as ReturnType<typeof vi.fn>;
const caseUpdate = prisma.targCase.update as unknown as ReturnType<typeof vi.fn>;
const repoLinkFindUnique = prisma.targRepoLink.findUnique as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setCaseRepoLinkForUser", () => {
  it("rejects when the case is not found or the user is not a member", async () => {
    caseFindFirst.mockResolvedValueOnce(null);

    await expect(
      setCaseRepoLinkForUser({
        userId: "u1",
        caseId: "missing",
        repoLinkId: "rlink-1",
      })
    ).rejects.toMatchObject({
      code: "case_not_found",
      status: 404,
    });
    expect(repoLinkFindUnique).not.toHaveBeenCalled();
    expect(caseUpdate).not.toHaveBeenCalled();
  });

  it("rejects when the repo link does not exist", async () => {
    caseFindFirst.mockResolvedValueOnce({ id: "case-1", workspaceId: "ws-1" });
    repoLinkFindUnique.mockResolvedValueOnce(null);

    await expect(
      setCaseRepoLinkForUser({
        userId: "u1",
        caseId: "case-1",
        repoLinkId: "ghost",
      })
    ).rejects.toMatchObject({
      code: "repo_link_not_found",
      status: 404,
    });
    expect(caseUpdate).not.toHaveBeenCalled();
  });

  it("rejects when the repo link belongs to a different workspace", async () => {
    caseFindFirst.mockResolvedValueOnce({ id: "case-1", workspaceId: "ws-1" });
    repoLinkFindUnique.mockResolvedValueOnce({
      id: "rlink-other",
      workspaceId: "ws-2",
    });

    await expect(
      setCaseRepoLinkForUser({
        userId: "u1",
        caseId: "case-1",
        repoLinkId: "rlink-other",
      })
    ).rejects.toMatchObject({
      code: "repo_link_wrong_workspace",
      status: 403,
    });
    expect(caseUpdate).not.toHaveBeenCalled();
  });

  it("clears the repo scope when repoLinkId is null (no link lookup)", async () => {
    caseFindFirst.mockResolvedValueOnce({ id: "case-1", workspaceId: "ws-1" });
    caseUpdate.mockResolvedValueOnce({
      repoLinkId: null,
      repoLink: null,
    });

    const result = await setCaseRepoLinkForUser({
      userId: "u1",
      caseId: "case-1",
      repoLinkId: null,
    });
    expect(result).toEqual({ repoLinkId: null, repoLink: null });
    // Crucially, we don't hit targRepoLink when clearing — no need to
    // validate a link that isn't being set.
    expect(repoLinkFindUnique).not.toHaveBeenCalled();
    expect(caseUpdate).toHaveBeenCalledWith({
      where: { id: "case-1" },
      data: { repoLinkId: null },
      select: expect.any(Object),
    });
  });

  it("pins the case to a repo when the link is in the same workspace", async () => {
    caseFindFirst.mockResolvedValueOnce({ id: "case-1", workspaceId: "ws-1" });
    repoLinkFindUnique.mockResolvedValueOnce({
      id: "rlink-1",
      workspaceId: "ws-1",
    });
    caseUpdate.mockResolvedValueOnce({
      repoLinkId: "rlink-1",
      repoLink: {
        id: "rlink-1",
        ownerLogin: "acme",
        repoName: "checkout",
        defaultBranch: "main",
        remoteUrl: "https://github.com/acme/checkout",
      },
    });

    const result = await setCaseRepoLinkForUser({
      userId: "u1",
      caseId: "case-1",
      repoLinkId: "rlink-1",
    });
    expect(result).toEqual({
      repoLinkId: "rlink-1",
      repoLink: {
        id: "rlink-1",
        ownerLogin: "acme",
        repoName: "checkout",
        defaultBranch: "main",
        remoteUrl: "https://github.com/acme/checkout",
      },
    });
  });

  it("wraps errors in CaseServiceError instances", async () => {
    caseFindFirst.mockResolvedValueOnce(null);
    await setCaseRepoLinkForUser({
      userId: "u1",
      caseId: "missing",
      repoLinkId: null,
    }).catch((error) => {
      expect(error).toBeInstanceOf(CaseServiceError);
      expect((error as CaseServiceError).code).toBe("case_not_found");
    });
  });
});
