/**
 * Tests for `loadRepoEnrichmentForCase` — the glue between the handoff
 * packet builder and the repo index. We mock Prisma + the repo-index
 * service so we can assert the policy decisions (which snapshot to pick,
 * when to kick a background sync) without spinning up a real database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    targCase: { findUnique: vi.fn() },
    targRepoLink: { findMany: vi.fn(), findUnique: vi.fn() },
    targRepoFile: { findMany: vi.fn() },
    targRepoSymbol: { findMany: vi.fn() },
    targGithubAccount: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/services/repo-index-service", () => ({
  isRepoSnapshotStale: vi.fn(),
  syncRepoTree: vi.fn(),
}));

// Mock the GitHub client so blame enrichment has a deterministic surface.
vi.mock("@/lib/github/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github/client")>(
    "@/lib/github/client"
  );
  return {
    ...actual,
    listCommitsForPath: vi.fn(),
  };
});

// Mock the token-cipher so `getDecryptedAccessToken` returns a plaintext
// token without needing a real TARG_TOKEN_CIPHER_KEY in the env.
vi.mock("@/lib/crypto/token-cipher", () => ({
  decryptToken: vi.fn(() => "ghu_fake_token"),
  encryptToken: vi.fn(),
}));

import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";
import { listCommitsForPath } from "@/lib/github/client";
import type { HandoffPacketInput } from "@/lib/handoff/packet";
import { prisma } from "@/lib/prisma";
import {
  isRepoSnapshotStale,
  syncRepoTree,
} from "@/lib/services/repo-index-service";

import { loadRepoEnrichmentForCase } from "./handoff-enrichment-service";

const caseFindUnique = prisma.targCase.findUnique as unknown as ReturnType<typeof vi.fn>;
const repoLinkFindMany = prisma.targRepoLink.findMany as unknown as ReturnType<typeof vi.fn>;
const repoLinkFindUnique = prisma.targRepoLink.findUnique as unknown as ReturnType<typeof vi.fn>;
const repoFileFindMany = prisma.targRepoFile.findMany as unknown as ReturnType<typeof vi.fn>;
const repoSymbolFindMany = prisma.targRepoSymbol.findMany as unknown as ReturnType<typeof vi.fn>;
const githubAccountFindUnique = prisma.targGithubAccount
  .findUnique as unknown as ReturnType<typeof vi.fn>;
const listCommitsMock = listCommitsForPath as unknown as ReturnType<typeof vi.fn>;
const isStaleMock = isRepoSnapshotStale as unknown as ReturnType<typeof vi.fn>;
const syncTreeMock = syncRepoTree as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: never stale (unless a test opts in).
  isStaleMock.mockResolvedValue(false);
  // Default: bg sync is a no-op that resolves immediately.
  syncTreeMock.mockResolvedValue({ id: "snap-fresh", status: "READY" });
  // Default: no connected GitHub account, so blame enrichment short-circuits.
  githubAccountFindUnique.mockResolvedValue(null);
  listCommitsMock.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function diagnosisVM(
  overrides: Partial<DiagnosisSnapshotViewModel> = {}
): DiagnosisSnapshotViewModel {
  return {
    id: "diag-1",
    caseId: "case-1",
    analysisRunId: "run-1",
    caseEvidenceVersion: 1,
    problemBrief: null,
    status: "provisional",
    confidence: "plausible",
    probableRootCause: "split service mismatch",
    affectedArea: "checkout service",
    summary: "The checkout service fails.",
    trace: [],
    hypotheses: [],
    contradictions: [],
    missingEvidence: [],
    nextActionMode: "verify",
    nextActionText: "Look at payments.",
    claimReferences: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function evidenceVM(overrides: Partial<EvidenceViewModel> = {}): EvidenceViewModel {
  return {
    id: "ev-1",
    caseId: "case-1",
    kind: "log",
    source: "upload",
    ingestStatus: "ready",
    originalName: "server.log",
    mimeType: "text/plain",
    rawStorageUrl: null,
    rawText: null,
    redactedText: null,
    extracted: {
      stackFrames: ["at foo (src/lib/checkout.ts:42:3)"],
    },
    caseEvidenceVersion: 1,
    createdAt: new Date().toISOString(),
    summary: null,
    parseWarnings: [],
    notices: [],
    secretsDetected: false,
    ...overrides,
  };
}

function sampleInput(): HandoffPacketInput {
  return {
    caseRecord: {
      id: "case-1",
      title: "T",
      userProblemStatement: "S",
      severity: null,
      problemLens: null,
      solveMode: null,
    },
    diagnosis: diagnosisVM(),
    evidence: [evidenceVM()],
    generator: {
      caseUrl: "https://example.test/cases/case-1",
      generatorVersion: "targ-handoff/test",
    },
  };
}

function mockRepoLink(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rlink-1",
    workspaceId: "ws-1",
    ownerLogin: "acme",
    repoName: "checkout",
    latestSnapshot: { id: "snap-1", commitSha: "deadbeef" },
    ...overrides,
  };
}

function mockFile(path: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    path,
    kind: "CODE",
    language: "typescript",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadRepoEnrichmentForCase", () => {
  it("returns undefined when the case does not exist", async () => {
    caseFindUnique.mockResolvedValueOnce(null);
    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "missing",
      input: sampleInput(),
    });
    expect(result).toBeUndefined();
    expect(syncTreeMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the workspace has no linked repos", async () => {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: null,
    });
    repoLinkFindMany.mockResolvedValueOnce([]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined AND fires background sync when the linked repo has no snapshot", async () => {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce({
      ...mockRepoLink({ latestSnapshot: null }),
    });

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });
    expect(result).toBeUndefined();
    expect(syncTreeMock).toHaveBeenCalledTimes(1);
    expect(syncTreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "ws-1",
        repoLinkId: "rlink-1",
      })
    );
  });

  it("enriches a case scoped to a repo link with a ready snapshot", async () => {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([
      mockFile("src/lib/checkout.ts"),
      mockFile("src/lib/other.ts"),
    ]);
    repoSymbolFindMany.mockResolvedValueOnce([]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    expect(result).toBeDefined();
    expect(result?.repoFullName).toBe("acme/checkout");
    expect(result?.ref).toBe("deadbeef");
    // The evidence has a stack frame pointing at src/lib/checkout.ts:42:3, so
    // the path resolver (real, not mocked here) should match.
    expect(result?.evidenceLocations?.["ev-1"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/lib/checkout.ts", line: 42 }),
      ])
    );
    // No bg sync because isStaleMock returned false.
    expect(syncTreeMock).not.toHaveBeenCalled();
  });

  it("fires background sync when the snapshot is stale but still uses it", async () => {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([mockFile("src/lib/checkout.ts")]);
    repoSymbolFindMany.mockResolvedValueOnce([]);
    isStaleMock.mockResolvedValueOnce(true);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    expect(result).toBeDefined();
    expect(result?.ref).toBe("deadbeef");
    expect(syncTreeMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when the snapshot has no files (broken index)", async () => {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([]);
    repoSymbolFindMany.mockResolvedValueOnce([]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    expect(result).toBeUndefined();
    expect(syncTreeMock).not.toHaveBeenCalled();
  });

  it("falls back to the workspace's sole linked repo when case.repoLinkId is null", async () => {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: null,
    });
    repoLinkFindMany.mockResolvedValueOnce([{ id: "rlink-only" }]);
    repoLinkFindUnique.mockResolvedValueOnce(
      mockRepoLink({ id: "rlink-only" })
    );
    repoFileFindMany.mockResolvedValueOnce([mockFile("src/app.ts")]);
    repoSymbolFindMany.mockResolvedValueOnce([]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    expect(result).toBeDefined();
    expect(repoLinkFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rlink-only" } })
    );
  });

  it("does NOT auto-scope when the workspace has multiple linked repos", async () => {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: null,
    });
    // findMany is called with take: 2 — if it returns 2, we skip enrichment
    // rather than guess which repo the user meant.
    repoLinkFindMany.mockResolvedValueOnce([
      { id: "rlink-a" },
      { id: "rlink-b" },
    ]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    expect(result).toBeUndefined();
    expect(repoLinkFindUnique).not.toHaveBeenCalled();
    expect(syncTreeMock).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Phase 2.5 — Blame + regression enrichment
  // -----------------------------------------------------------------------

  function primeEnrichedCase() {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([
      mockFile("src/lib/checkout.ts"),
    ]);
    repoSymbolFindMany.mockResolvedValueOnce([]);
  }

  it("skips blame enrichment when no GitHub account is connected", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce(null);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    expect(result?.evidenceLocations?.["ev-1"]?.[0].blame).toBeUndefined();
    expect(result?.suspectedRegressions).toBeUndefined();
    expect(listCommitsMock).not.toHaveBeenCalled();
  });

  it("populates blame on resolved locations when a GitHub token is available", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    listCommitsMock.mockResolvedValueOnce([
      {
        sha: "abc123",
        message: "fix: null check in checkout (#842)",
        authorLogin: "alice",
        authorName: "Alice",
        authorEmail: null,
        date: new Date(Date.now() - 86_400_000).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/abc123",
      },
    ]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    const loc = result?.evidenceLocations?.["ev-1"]?.[0];
    expect(loc?.blame).toMatchObject({
      author: "alice",
      commitSha: "abc123",
      commitMessage: "fix: null check in checkout (#842)",
      prNumber: 842,
    });
    expect(result?.suspectedRegressions?.[0]).toMatchObject({
      sha: "abc123",
      touchedFiles: ["src/lib/checkout.ts"],
    });
  });

  it("gracefully degrades when listCommitsForPath throws", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    listCommitsMock.mockRejectedValueOnce(new Error("rate limited"));

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    // Enrichment still ships, just without blame.
    expect(result?.ref).toBe("deadbeef");
    expect(result?.evidenceLocations?.["ev-1"]?.[0].blame).toBeUndefined();
    expect(result?.suspectedRegressions).toBeUndefined();
  });

  it("calls list-commits with the snapshot's commit SHA as ref", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    listCommitsMock.mockResolvedValueOnce([]);

    await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    expect(listCommitsMock).toHaveBeenCalledWith(
      "ghu_fake_token",
      "acme",
      "checkout",
      "src/lib/checkout.ts",
      expect.objectContaining({ ref: "deadbeef" })
    );
  });
});
