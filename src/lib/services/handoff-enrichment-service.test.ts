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
// Phase 2.6: `getFileBlameRanges` (GraphQL) drives per-line blame and the
// file-level fallback. `listCommitsForPath` (REST) drives suspected
// regressions only.
vi.mock("@/lib/github/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github/client")>(
    "@/lib/github/client"
  );
  return {
    ...actual,
    listCommitsForPath: vi.fn(),
    getFileBlameRanges: vi.fn(),
    // Phase 2.9 — diff-aware rerank. Default: every call resolves to
    // an empty diff so tests that don't care about diffs behave
    // identically to Phase 2.7.
    getCommitDiff: vi.fn(),
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
import {
  getCommitDiff,
  getFileBlameRanges,
  listCommitsForPath,
} from "@/lib/github/client";
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
const getBlameMock = getFileBlameRanges as unknown as ReturnType<typeof vi.fn>;
const getCommitDiffMock = getCommitDiff as unknown as ReturnType<typeof vi.fn>;
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
  getBlameMock.mockResolvedValue({ ranges: [], mostRecentCommit: null });
  getCommitDiffMock.mockResolvedValue({
    sha: "default",
    files: [],
    truncated: false,
  });
});

// Helper: builds a one-range GraphQL blame response covering a wide line
// window so any reasonable `line` (1..1000) maps to the same commit. Use
// for tests that don't care about line-level routing.
function singleRangeBlame(
  commit: {
    sha: string;
    message: string;
    authorLogin?: string | null;
    authorName?: string;
    date?: string;
    htmlUrl?: string;
  }
) {
  const c = {
    sha: commit.sha,
    message: commit.message,
    authorLogin: commit.authorLogin ?? null,
    authorName: commit.authorName ?? "Author",
    authorEmail: null,
    date: commit.date ?? new Date(Date.now() - 86_400_000).toISOString(),
    htmlUrl: commit.htmlUrl ?? `https://github.com/x/y/commit/${commit.sha}`,
  };
  return {
    ranges: [{ startingLine: 1, endingLine: 1000, commit: c }],
    mostRecentCommit: c,
  };
}

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
    expect(getBlameMock).not.toHaveBeenCalled();
  });

  it("populates blame on resolved locations when a GitHub token is available", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({
        sha: "abc123",
        message: "fix: null check in checkout (#842)",
        authorLogin: "alice",
        authorName: "Alice",
        htmlUrl: "https://github.com/acme/checkout/commit/abc123",
      })
    );
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

  it("gracefully degrades when both blame queries fail", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockRejectedValueOnce(new Error("graphql 502"));
    listCommitsMock.mockRejectedValueOnce(new Error("rate limited"));

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    // Enrichment still ships, just without blame or regressions.
    expect(result?.ref).toBe("deadbeef");
    expect(result?.evidenceLocations?.["ev-1"]?.[0].blame).toBeUndefined();
    expect(result?.suspectedRegressions).toBeUndefined();
  });

  it("calls list-commits + get-blame with the snapshot's commit SHA as ref", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    listCommitsMock.mockResolvedValueOnce([]);
    getBlameMock.mockResolvedValueOnce({ ranges: [], mostRecentCommit: null });

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
    expect(getBlameMock).toHaveBeenCalledWith(
      "ghu_fake_token",
      "acme",
      "checkout",
      "deadbeef",
      "src/lib/checkout.ts"
    );
  });

  // ---------------------------------------------------------------------
  // Phase 2.6 — line-level blame
  // ---------------------------------------------------------------------

  it("routes the location's line through the GraphQL blame ranges", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    // Two distinct ranges in the file. The evidence stack frame points at
    // line 42, which falls in range 11..100 → should attribute to
    // commit `bob-late`, NOT `alice-early`.
    getBlameMock.mockResolvedValueOnce({
      ranges: [
        {
          startingLine: 1,
          endingLine: 10,
          commit: {
            sha: "alice-early",
            message: "initial",
            authorLogin: "alice",
            authorName: "Alice",
            authorEmail: null,
            date: "2026-04-01T00:00:00Z",
            htmlUrl: "https://github.com/x/y/commit/alice-early",
          },
        },
        {
          startingLine: 11,
          endingLine: 100,
          commit: {
            sha: "bob-late",
            message: "fix: hot path (#9)",
            authorLogin: "bob",
            authorName: "Bob",
            authorEmail: null,
            date: "2026-04-15T00:00:00Z",
            htmlUrl: "https://github.com/x/y/commit/bob-late",
          },
        },
      ],
      mostRecentCommit: {
        sha: "bob-late",
        message: "fix: hot path (#9)",
        authorLogin: "bob",
        authorName: "Bob",
        authorEmail: null,
        date: "2026-04-15T00:00:00Z",
        htmlUrl: "https://github.com/x/y/commit/bob-late",
      },
    });
    listCommitsMock.mockResolvedValueOnce([]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    const loc = result?.evidenceLocations?.["ev-1"]?.[0];
    expect(loc?.line).toBe(42);
    expect(loc?.blame).toMatchObject({
      author: "bob",
      commitSha: "bob-late",
      prNumber: 9,
    });
  });

  it("caches per-file blame so multiple lines on the same file share one GraphQL call", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockResolvedValue(
      singleRangeBlame({
        sha: "shared",
        message: "init",
        authorLogin: "alice",
      })
    );
    listCommitsMock.mockResolvedValue([]);

    // Override sample input to add a second evidence item with a frame on
    // the same file but a different line, so we get TWO distinct
    // (file, line) keys in the enrichment.
    const input = sampleInput();
    input.evidence.push(
      evidenceVM({
        id: "ev-2",
        extracted: {
          stackFrames: ["at bar (src/lib/checkout.ts:99:1)"],
        },
      })
    );

    await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input,
    });

    // Despite (file, 42) and (file, 99) being distinct location keys, the
    // service caches per FILE so getFileBlameRanges should be called once.
    expect(getBlameMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // Phase 2.7 — likely-culprit detection
  // ---------------------------------------------------------------------

  it("populates likelyCulprit when a regression strongly matches the affected area", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({
        sha: "winner-sha",
        message: "fix: handle null in checkout flow (#842)",
        authorLogin: "alice",
      })
    );
    listCommitsMock.mockResolvedValueOnce([
      {
        sha: "winner-sha",
        message: "fix: handle null in checkout flow (#842)",
        authorLogin: "alice",
        authorName: "Alice",
        authorEmail: null,
        date: new Date(Date.now() - 86_400_000).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/winner-sha",
      },
    ]);

    // Override the diagnosis affectedArea with a string the commit will
    // strongly match (multiple shared keywords → high score).
    const input = sampleInput();
    input.diagnosis = diagnosisVM({
      affectedArea: "checkout flow null handler",
      probableRootCause: "missing null guard in checkout",
    });

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input,
    });

    expect(result?.likelyCulprit).toBeDefined();
    expect(result?.likelyCulprit?.sha).toBe("winner-sha");
    expect(["high", "medium"]).toContain(result?.likelyCulprit?.confidence);
    expect(result?.likelyCulprit?.reasons.length).toBeGreaterThan(0);
  });

  it("omits likelyCulprit when no regression clears the medium threshold", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({
        sha: "noise",
        message: "chore: bump dependency versions",
        authorLogin: "carol",
      })
    );
    // Make the regression touch a file the resolver did NOT pick up, and
    // give it a totally unrelated message → score should be near zero.
    listCommitsMock.mockResolvedValueOnce([
      {
        sha: "noise",
        message: "chore: bump dependency versions",
        authorLogin: "carol",
        authorName: "Carol",
        authorEmail: null,
        // Inside the 30-day regression window so it's still listed as a
        // suspected regression, but outside the 7-day culprit recency
        // window so recency alone doesn't push it past the threshold.
        date: new Date(Date.now() - 86_400_000 * 20).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/noise",
      },
    ]);

    const input = sampleInput();
    input.diagnosis = diagnosisVM({
      // No keyword overlap with the commit message ("bump dependency
      // versions") and no resolved-file overlap → score = 0.
      affectedArea: "completely unrelated subsystem",
      probableRootCause: "something else entirely",
    });

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input,
    });

    expect(result?.suspectedRegressions).toBeDefined();
    expect(result?.likelyCulprit).toBeUndefined();
  });

  it("does not run culprit detection when there are no suspected regressions", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({ sha: "x", message: "y", authorLogin: "z" })
    );
    // Empty list → no regressions populated → no culprit.
    listCommitsMock.mockResolvedValueOnce([]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    expect(result?.suspectedRegressions).toBeUndefined();
    expect(result?.likelyCulprit).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Phase 2.8 — negative evidence plumbed through the service
  // ---------------------------------------------------------------------

  it("passes contradictions through so scope-disjoint commits get demoted", async () => {
    // Prime with an android file so the enrichment resolver places the
    // evidence location there and the downstream aggregator reports the
    // commit as having touched an android-scoped file. (Recall: the
    // aggregator's `touchedFiles` is derived from resolved files, not
    // from the github commit payload.)
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([
      mockFile("android/app/src/main/java/Checkout.kt"),
    ]);
    repoSymbolFindMany.mockResolvedValueOnce([]);

    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({
        sha: "android-sha",
        message: "fix: handle null in checkout flow",
        authorLogin: "alice",
      })
    );
    // One recent commit whose message strongly matches the affected
    // area. Because the resolved file is android-scoped, the commit
    // will aggregate as `touchedFiles: ["android/.../Checkout.kt"]` →
    // `classifyCommitScopes` yields `{android}` → the "Only on iOS"
    // contradiction excludes android → penalty fires → confidence
    // capped at medium.
    listCommitsMock.mockResolvedValueOnce([
      {
        sha: "android-sha",
        message: "fix: handle null in checkout flow",
        authorLogin: "alice",
        authorName: "Alice",
        authorEmail: null,
        date: new Date(Date.now() - 86_400_000).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/android-sha",
      },
    ]);

    // Point the evidence stack frame at the android file so the
    // resolver places the location there deterministically.
    const input = sampleInput();
    input.evidence = [
      evidenceVM({
        extracted: {
          stackFrames: [
            "at foo (android/app/src/main/java/Checkout.kt:42:3)",
          ],
        },
      }),
    ];
    input.diagnosis = diagnosisVM({
      affectedArea: "checkout flow null handler",
      probableRootCause: "missing null guard in checkout",
      contradictions: ["Only reproduces on iOS — Android users unaffected"],
    });

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input,
    });

    expect(result?.likelyCulprit).toBeDefined();
    expect(result?.likelyCulprit?.sha).toBe("android-sha");
    expect(result?.likelyCulprit?.confidence).toBe("medium");
    expect(
      result?.likelyCulprit?.reasons.some((r) =>
        r.startsWith("but contradicts scope")
      )
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Phase 2.9 — diff-aware rerank integration
  // -------------------------------------------------------------------------

  it("promotes the runner-up when its diff actually modifies the stack-frame line", async () => {
    // Two regression candidates touching the same file. The "leader"
    // is slightly more recent (1d ago vs 3d), so the first-pass
    // scorer prefers it. But the "truth" commit is the one whose
    // diff covers line 42 — the diff-aware second pass should flip
    // the pick.
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([mockFile("src/lib/checkout.ts")]);
    repoSymbolFindMany.mockResolvedValueOnce([]);

    githubAccountFindUnique.mockResolvedValue({
      accessTokenEnc: "encrypted-blob",
    });
    // Blame picks leader as the most-recent toucher of the file. Not
    // critical for this test — we only care about regression ranking.
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({
        sha: "leader-sha",
        message: "refactor: checkout flow",
        authorLogin: "alice",
      })
    );
    const now = Date.now();
    listCommitsMock.mockResolvedValueOnce([
      {
        sha: "leader-sha",
        message: "refactor: checkout flow",
        authorLogin: "alice",
        authorName: "Alice",
        authorEmail: null,
        date: new Date(now - 1 * 86_400_000).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/leader-sha",
      },
      {
        sha: "truth-sha",
        message: "fix: checkout submit flow",
        authorLogin: "bob",
        authorName: "Bob",
        authorEmail: null,
        date: new Date(now - 3 * 86_400_000).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/truth-sha",
      },
    ]);

    // Diff-aware mocks: only `truth-sha` has a hunk covering line 42.
    getCommitDiffMock.mockImplementation(async (_tok, _o, _r, sha) => {
      if (sha === "truth-sha") {
        return {
          sha,
          truncated: false,
          files: [
            {
              path: "src/lib/checkout.ts",
              previousPath: null,
              status: "modified" as const,
              additions: 2,
              deletions: 1,
              hunks: [{ oldStart: 40, oldLines: 3, newStart: 40, newLines: 5 }],
            },
          ],
        };
      }
      return {
        sha,
        truncated: false,
        files: [
          {
            path: "src/lib/checkout.ts",
            previousPath: null,
            status: "modified" as const,
            additions: 1,
            deletions: 0,
            // Leader touches the file but at a different range.
            hunks: [{ oldStart: 100, oldLines: 1, newStart: 100, newLines: 2 }],
          },
        ],
      };
    });

    const input = sampleInput();
    input.evidence = [
      evidenceVM({
        extracted: {
          stackFrames: ["at foo (src/lib/checkout.ts:42:3)"],
        },
      }),
    ];
    input.diagnosis = diagnosisVM({
      affectedArea: "checkout flow",
      probableRootCause: "submit boundary regression",
    });

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input,
    });

    expect(result?.likelyCulprit).toBeDefined();
    expect(result?.likelyCulprit?.sha).toBe("truth-sha");
    expect(
      result?.likelyCulprit?.reasons.some((r) =>
        r.includes("diff touches src/lib/checkout.ts:42")
      )
    ).toBe(true);
  });

  it("skips diff fetch entirely when no resolved stack lines are available", async () => {
    // Evidence carries no stack frames → resolver yields no line-typed
    // stack locations → second pass short-circuits → getCommitDiff
    // must never be called.
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([mockFile("src/lib/checkout.ts")]);
    repoSymbolFindMany.mockResolvedValueOnce([]);
    githubAccountFindUnique.mockResolvedValue({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({
        sha: "only-sha",
        message: "fix: checkout",
        authorLogin: "alice",
      })
    );
    listCommitsMock.mockResolvedValueOnce([
      {
        sha: "only-sha",
        message: "fix: checkout",
        authorLogin: "alice",
        authorName: "Alice",
        authorEmail: null,
        date: new Date(Date.now() - 86_400_000).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/only-sha",
      },
    ]);

    const input = sampleInput();
    // Affected area has a path hint so the enrichment resolver still
    // produces a file resolution, but no stack frames → no line info.
    input.evidence = [evidenceVM({ extracted: { stackFrames: [] } })];
    input.diagnosis = diagnosisVM({
      affectedArea: "src/lib/checkout.ts",
      probableRootCause: "checkout bug",
    });

    await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input,
    });

    expect(getCommitDiffMock).not.toHaveBeenCalled();
  });

  it("falls back to first-pass pick when every diff fetch fails", async () => {
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([mockFile("src/lib/checkout.ts")]);
    repoSymbolFindMany.mockResolvedValueOnce([]);
    githubAccountFindUnique.mockResolvedValue({
      accessTokenEnc: "encrypted-blob",
    });
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({
        sha: "pick-sha",
        message: "fix: checkout flow",
        authorLogin: "alice",
      })
    );
    listCommitsMock.mockResolvedValueOnce([
      {
        sha: "pick-sha",
        message: "fix: checkout flow regression",
        authorLogin: "alice",
        authorName: "Alice",
        authorEmail: null,
        date: new Date(Date.now() - 86_400_000).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/pick-sha",
      },
    ]);
    // Every diff fetch blows up — simulates GitHub outage or revoked
    // token mid-flight. The packet must still ship with the first
    // pass's culprit pick.
    getCommitDiffMock.mockRejectedValue(new Error("diff endpoint 502"));

    const input = sampleInput();
    input.evidence = [
      evidenceVM({
        extracted: {
          stackFrames: ["at foo (src/lib/checkout.ts:42:3)"],
        },
      }),
    ];
    input.diagnosis = diagnosisVM({
      affectedArea: "checkout flow",
      probableRootCause: "regression in checkout",
    });

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input,
    });

    // First-pass pick survives — no crash, no missing culprit.
    expect(result?.likelyCulprit?.sha).toBe("pick-sha");
    // No diff-touches reason because every fetch failed.
    expect(
      result?.likelyCulprit?.reasons.every((r) => !r.includes("diff touches"))
    ).toBe(true);
  });

  it("falls back to first-pass pick when the user has no connected GitHub account", async () => {
    // No account → no token → diff fetch short-circuits. This is the
    // same path as "diffs fail" but earlier. Verify it doesn't crash
    // AND doesn't even try to call the diff endpoint.
    caseFindUnique.mockResolvedValueOnce({
      workspaceId: "ws-1",
      repoLinkId: "rlink-1",
    });
    repoLinkFindUnique.mockResolvedValueOnce(mockRepoLink());
    repoFileFindMany.mockResolvedValueOnce([mockFile("src/lib/checkout.ts")]);
    repoSymbolFindMany.mockResolvedValueOnce([]);
    // Blame enrichment runs once with a token for the regression list,
    // then the diff fetch tries again but the mock returns no account.
    githubAccountFindUnique
      .mockResolvedValueOnce({ accessTokenEnc: "encrypted-blob" }) // blame
      .mockResolvedValue(null); // diff probe
    getBlameMock.mockResolvedValueOnce(
      singleRangeBlame({
        sha: "pick-sha",
        message: "fix: checkout flow regression",
        authorLogin: "alice",
      })
    );
    listCommitsMock.mockResolvedValueOnce([
      {
        sha: "pick-sha",
        message: "fix: checkout flow regression",
        authorLogin: "alice",
        authorName: "Alice",
        authorEmail: null,
        date: new Date(Date.now() - 86_400_000).toISOString(),
        htmlUrl: "https://github.com/acme/checkout/commit/pick-sha",
      },
    ]);

    const input = sampleInput();
    input.evidence = [
      evidenceVM({
        extracted: {
          stackFrames: ["at foo (src/lib/checkout.ts:42:3)"],
        },
      }),
    ];
    input.diagnosis = diagnosisVM({
      affectedArea: "checkout flow",
      probableRootCause: "regression in checkout",
    });

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input,
    });

    expect(result?.likelyCulprit?.sha).toBe("pick-sha");
    expect(getCommitDiffMock).not.toHaveBeenCalled();
  });

  it("falls back to file-level blame when the line is outside all ranges", async () => {
    primeEnrichedCase();
    githubAccountFindUnique.mockResolvedValueOnce({
      accessTokenEnc: "encrypted-blob",
    });
    // Range only covers lines 1..10 but the evidence points at line 42.
    getBlameMock.mockResolvedValueOnce({
      ranges: [
        {
          startingLine: 1,
          endingLine: 10,
          commit: {
            sha: "early",
            message: "early",
            authorLogin: "alice",
            authorName: "Alice",
            authorEmail: null,
            date: "2026-04-01T00:00:00Z",
            htmlUrl: "https://github.com/x/y/commit/early",
          },
        },
      ],
      mostRecentCommit: {
        sha: "fallback",
        message: "later head",
        authorLogin: "carol",
        authorName: "Carol",
        authorEmail: null,
        date: "2026-04-18T00:00:00Z",
        htmlUrl: "https://github.com/x/y/commit/fallback",
      },
    });
    listCommitsMock.mockResolvedValueOnce([]);

    const result = await loadRepoEnrichmentForCase({
      userId: "u1",
      caseId: "case-1",
      input: sampleInput(),
    });

    const loc = result?.evidenceLocations?.["ev-1"]?.[0];
    expect(loc?.blame?.commitSha).toBe("fallback");
    expect(loc?.blame?.author).toBe("carol");
  });
});
