/**
 * Unit tests for the Handoff Packet repo enrichment adapter.
 *
 * We test two layers:
 *   1. `extractEvidenceHints` — pure hint extraction from evidence view
 *      models. No resolvers. Validates we catch stack frames, services,
 *      path mentions.
 *   2. `enrichPacketInput` — the full adapter. We inject fake resolvers so
 *      we can assert deterministic `RepoEnrichmentInput` output without
 *      touching Prisma or real snapshots.
 */

import { describe, expect, it } from "vitest";

import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";
import type { HandoffPacketInput } from "@/lib/handoff/packet";
import {
  enrichPacketInput,
  extractEvidenceHints,
  extractPathsFromText,
  type EnrichmentContext,
} from "@/lib/handoff/repo-enrichment";
import type {
  ResolvedCandidate,
  ResolvedSymbolCandidate,
} from "@/lib/repo-index/resolver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function evidence(
  overrides: Partial<EvidenceViewModel>
): EvidenceViewModel {
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
    extracted: null,
    caseEvidenceVersion: 1,
    createdAt: new Date().toISOString(),
    summary: null,
    parseWarnings: [],
    notices: [],
    secretsDetected: false,
    ...overrides,
  };
}

function diagnosis(
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
    summary: "The checkout service fails for large carts.",
    trace: [],
    hypotheses: [],
    contradictions: [],
    missingEvidence: [],
    nextActionMode: "verify",
    nextActionText: "Inspect payment reconciliation.",
    claimReferences: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInput(
  evidenceList: EvidenceViewModel[],
  diagnosisOverrides: Partial<DiagnosisSnapshotViewModel> = {}
): HandoffPacketInput {
  return {
    caseRecord: {
      id: "case-1",
      title: "Checkout fails",
      userProblemStatement: "Checkout fails for large carts",
      severity: "HIGH",
      problemLens: null,
      solveMode: null,
    },
    diagnosis: diagnosis(diagnosisOverrides),
    evidence: evidenceList,
    generator: {
      caseUrl: "https://example.test/cases/case-1",
      generatorVersion: "targ-handoff/1.0.0",
    },
  };
}

type FakeCandidate = Partial<ResolvedCandidate> & {
  path: string;
  score: number;
};
type FakeSymbol = Partial<ResolvedSymbolCandidate> & {
  name: string;
  filePath: string;
  line: number;
  score: number;
};

function fakeResolvers(params: {
  pathResponses?: Record<string, FakeCandidate[]>;
  symbolResponses?: Record<string, FakeSymbol[]>;
  pathDefault?: FakeCandidate[];
  symbolDefault?: FakeSymbol[];
}): Pick<EnrichmentContext, "resolvePath" | "resolveSymbol"> {
  const {
    pathResponses = {},
    symbolResponses = {},
    pathDefault = [],
    symbolDefault = [],
  } = params;
  return {
    resolvePath: (hint) => {
      const raw = pathResponses[hint] ?? pathDefault;
      return raw.map((c) => ({
        path: c.path,
        kind: c.kind ?? "CODE",
        language: c.language ?? "typescript",
        score: c.score,
        reasons: c.reasons ?? [],
        line: c.line,
      }));
    },
    resolveSymbol: (query) => {
      const raw = symbolResponses[query] ?? symbolDefault;
      return raw.map((s) => ({
        name: s.name,
        kind: s.kind ?? "FUNCTION",
        line: s.line,
        endLine: s.endLine ?? null,
        exported: s.exported ?? true,
        filePath: s.filePath,
        fileKind: s.fileKind ?? "CODE",
        fileLanguage: s.fileLanguage ?? "typescript",
        score: s.score,
        reasons: s.reasons ?? [],
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// extractPathsFromText
// ---------------------------------------------------------------------------

describe("extractPathsFromText", () => {
  it("extracts simple paths with and without line numbers", () => {
    const out = extractPathsFromText(
      "See src/lib/checkout.ts for details, specifically src/lib/checkout.ts:42 and docs/readme.md."
    );
    expect(out).toContain("src/lib/checkout.ts");
    expect(out).toContain("src/lib/checkout.ts:42");
    expect(out).toContain("docs/readme.md");
  });

  it("does not match URLs", () => {
    const out = extractPathsFromText(
      "Check https://example.com/foo.ts for reference."
    );
    expect(out).not.toContain("foo.ts");
  });

  it("returns an empty array on plain text", () => {
    expect(extractPathsFromText("nothing to see here")).toEqual([]);
  });

  it("handles #L42 GitHub-style anchors", () => {
    const out = extractPathsFromText("src/app/page.tsx#L12 is the culprit.");
    expect(out).toContain("src/app/page.tsx#L12");
  });
});

// ---------------------------------------------------------------------------
// extractEvidenceHints
// ---------------------------------------------------------------------------

describe("extractEvidenceHints", () => {
  it("parses stack-frame locations and function names", () => {
    const hints = extractEvidenceHints(
      evidence({
        extracted: {
          stackFrames: [
            "at CheckoutService.handle (src/lib/checkout-service.ts:42:15)",
            "at Object.<anonymous> (src/app/api/checkout/route.ts:12:7)",
          ],
        },
      })
    );
    expect(hints.stackHints).toContain("src/lib/checkout-service.ts:42:15");
    expect(hints.stackHints).toContain("src/app/api/checkout/route.ts:12:7");
    expect(hints.symbolHints).toContain("CheckoutService.handle");
  });

  it("accepts stack frames in object form with a `raw` field", () => {
    const hints = extractEvidenceHints(
      evidence({
        extracted: {
          stackFrames: [
            { raw: "at foo (src/foo.ts:10:3)", lineNumber: 10 },
          ],
        },
      })
    );
    expect(hints.stackHints).toContain("src/foo.ts:10:3");
  });

  it("collects service names as symbol hints", () => {
    const hints = extractEvidenceHints(
      evidence({
        extracted: {
          services: ["CheckoutService", "PaymentGateway"],
        },
      })
    );
    expect(hints.symbolHints).toEqual(
      expect.arrayContaining(["CheckoutService", "PaymentGateway"])
    );
  });

  it("extracts free-text path mentions in the summary", () => {
    const hints = extractEvidenceHints(
      evidence({
        summary: "Failure observed in src/lib/checkout.ts:42 and config/db.yml.",
      })
    );
    expect(hints.pathHints).toContain("src/lib/checkout.ts:42");
    expect(hints.pathHints).toContain("config/db.yml");
  });

  it("feeds the summary itself as a symbol query", () => {
    const hints = extractEvidenceHints(
      evidence({
        summary: "CheckoutService returned a 500 error on large carts.",
      })
    );
    expect(hints.symbolHints).toContain(
      "CheckoutService returned a 500 error on large carts."
    );
  });

  it("handles evidence with no extracted metadata", () => {
    const hints = extractEvidenceHints(evidence({ summary: null }));
    expect(hints).toEqual({
      pathHints: [],
      symbolHints: [],
      stackHints: [],
    });
  });

  it("parses bare `at func path:line` stack frames without parens", () => {
    const hints = extractEvidenceHints(
      evidence({
        extracted: {
          stackFrames: [
            "  at CheckoutService.handle src/lib/checkout-service.ts:42:15",
          ],
        },
      })
    );
    expect(hints.stackHints).toContain("src/lib/checkout-service.ts:42:15");
  });
});

// ---------------------------------------------------------------------------
// enrichPacketInput
// ---------------------------------------------------------------------------

describe("enrichPacketInput", () => {
  it("populates repoContext with repoFullName + ref even when nothing resolves", () => {
    const input = makeInput([evidence({ summary: "nothing useful" })]);
    const enrichment = enrichPacketInput(input, {
      repoFullName: "acme/checkout",
      ref: "deadbeefcafebabe",
      ...fakeResolvers({}),
    });
    expect(enrichment.repoFullName).toBe("acme/checkout");
    expect(enrichment.ref).toBe("deadbeefcafebabe");
    expect(enrichment.evidenceLocations).toBeUndefined();
    expect(enrichment.stackLocations).toBeUndefined();
    expect(enrichment.affectedAreaLocation).toBeUndefined();
  });

  it("resolves the affected area via the path resolver", () => {
    const input = makeInput([], { affectedArea: "checkout service" });
    const enrichment = enrichPacketInput(input, {
      repoFullName: "acme/checkout",
      ref: "sha123",
      ...fakeResolvers({
        pathResponses: {
          "checkout service": [
            { path: "src/lib/checkout-service.ts", score: 0.9 },
          ],
        },
      }),
    });
    expect(enrichment.affectedAreaLocation).toEqual({
      file: "src/lib/checkout-service.ts",
    });
  });

  it("prefers higher-score candidate when path + symbol resolvers both hit", () => {
    const input = makeInput([], { affectedArea: "CheckoutService" });
    const enrichment = enrichPacketInput(input, {
      repoFullName: "acme/checkout",
      ref: "sha123",
      ...fakeResolvers({
        pathResponses: {
          CheckoutService: [
            { path: "src/lib/checkout-service.ts", score: 0.4 },
          ],
        },
        symbolResponses: {
          CheckoutService: [
            {
              name: "CheckoutService",
              filePath: "src/lib/checkout-service.ts",
              line: 42,
              score: 0.85,
            },
          ],
        },
      }),
    });
    expect(enrichment.affectedAreaLocation).toEqual({
      file: "src/lib/checkout-service.ts",
      line: 42,
    });
  });

  it("drops candidates below the minimum score floor (0.25)", () => {
    const input = makeInput([], { affectedArea: "mystery component" });
    const enrichment = enrichPacketInput(input, {
      repoFullName: "acme/checkout",
      ref: "sha123",
      ...fakeResolvers({
        pathResponses: {
          "mystery component": [
            { path: "src/noise.ts", score: 0.2 },
          ],
        },
      }),
    });
    expect(enrichment.affectedAreaLocation).toBeUndefined();
  });

  it("aggregates stack-frame locations from all evidence into stackLocations", () => {
    const input = makeInput([
      evidence({
        id: "ev-1",
        extracted: {
          stackFrames: ["at foo (src/lib/a.ts:10:3)"],
        },
      }),
      evidence({
        id: "ev-2",
        extracted: {
          stackFrames: ["at bar (src/lib/b.ts:20:5)"],
        },
      }),
    ]);
    const enrichment = enrichPacketInput(input, {
      repoFullName: "acme/checkout",
      ref: "sha123",
      ...fakeResolvers({
        pathResponses: {
          "src/lib/a.ts:10:3": [{ path: "src/lib/a.ts", line: 10, score: 0.95 }],
          "src/lib/b.ts:20:5": [{ path: "src/lib/b.ts", line: 20, score: 0.95 }],
        },
      }),
    });
    expect(enrichment.stackLocations).toEqual([
      { file: "src/lib/a.ts", line: 10 },
      { file: "src/lib/b.ts", line: 20 },
    ]);
    expect(enrichment.evidenceLocations).toMatchObject({
      "ev-1": [{ file: "src/lib/a.ts", line: 10 }],
      "ev-2": [{ file: "src/lib/b.ts", line: 20 }],
    });
  });

  it("dedupes evidence locations by (file, line)", () => {
    const input = makeInput([
      evidence({
        id: "ev-1",
        summary: "see src/lib/foo.ts:42",
        extracted: {
          stackFrames: ["at foo (src/lib/foo.ts:42:1)"],
          services: ["FooService"],
        },
      }),
    ]);
    const enrichment = enrichPacketInput(input, {
      repoFullName: "acme/checkout",
      ref: "sha123",
      ...fakeResolvers({
        pathResponses: {
          "src/lib/foo.ts:42": [{ path: "src/lib/foo.ts", line: 42, score: 0.9 }],
          "src/lib/foo.ts:42:1": [
            { path: "src/lib/foo.ts", line: 42, score: 0.95 },
          ],
        },
        symbolResponses: {
          FooService: [
            {
              name: "FooService",
              filePath: "src/lib/foo.ts",
              line: 42,
              score: 0.8,
            },
          ],
        },
      }),
    });
    const ev1Locations = enrichment.evidenceLocations?.["ev-1"] ?? [];
    expect(ev1Locations).toHaveLength(1);
    expect(ev1Locations[0]).toEqual({ file: "src/lib/foo.ts", line: 42 });
  });

  it("caps per-evidence locations at 3", () => {
    const input = makeInput([
      evidence({
        id: "ev-1",
        summary: "a b c d e",
      }),
    ]);
    const enrichment = enrichPacketInput(input, {
      repoFullName: "acme/checkout",
      ref: "sha123",
      ...fakeResolvers({
        symbolDefault: [
          { name: "A", filePath: "src/a.ts", line: 1, score: 0.9 },
          { name: "B", filePath: "src/b.ts", line: 1, score: 0.85 },
          { name: "C", filePath: "src/c.ts", line: 1, score: 0.8 },
          { name: "D", filePath: "src/d.ts", line: 1, score: 0.75 },
          { name: "E", filePath: "src/e.ts", line: 1, score: 0.7 },
        ],
      }),
    });
    expect(enrichment.evidenceLocations?.["ev-1"]).toHaveLength(3);
  });

  it("caps stackLocations at 5", () => {
    const frames = Array.from({ length: 10 }, (_, i) => `at f${i} (src/f${i}.ts:${i + 1}:1)`);
    const input = makeInput([
      evidence({ id: "ev-1", extracted: { stackFrames: frames } }),
    ]);
    const ctx: EnrichmentContext = {
      repoFullName: "acme/checkout",
      ref: "sha123",
      ...fakeResolvers({
        pathDefault: [],
      }),
    };
    const pathResponses: Record<string, FakeCandidate[]> = {};
    for (let i = 0; i < 10; i++) {
      pathResponses[`src/f${i}.ts:${i + 1}:1`] = [
        { path: `src/f${i}.ts`, line: i + 1, score: 0.9 },
      ];
    }
    const enrichment = enrichPacketInput(input, {
      ...ctx,
      ...fakeResolvers({ pathResponses }),
    });
    expect(enrichment.stackLocations).toHaveLength(5);
  });
});
