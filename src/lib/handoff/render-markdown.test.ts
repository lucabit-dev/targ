/**
 * Handoff packet contract tests (Phase 1.5).
 *
 * These tests exist to lock the behaviour described in
 *   - docs/handoff-packet.md (spec)
 *   - docs/examples/packet-contradiction-split-service.md (worked example)
 *
 * They are **snapshot-bound**: any intentional change to the builder,
 * renderer, or truncation logic must regenerate the snapshot and be reviewed
 * in the same change. Accidental shape drift fails the suite.
 *
 * Run: `npm test`
 */

import { describe, expect, it } from "vitest";

import {
  assertPacketValid,
  buildHandoffPacket,
  HandoffPacketInvariantError,
  translateConfidence,
} from "@/lib/handoff/packet";
import {
  appendAgentInstructions,
  renderForCursor,
  renderPacketMarkdown,
} from "@/lib/handoff/render-markdown";
import {
  buildMinimalPacket,
  truncatePacketToBudget,
} from "@/lib/handoff/truncate";
import {
  CONTRADICTION_FIXTURE_INPUT,
  CONTRADICTION_FIXTURE_META,
} from "@/lib/handoff/fixtures/contradiction-split-service";

const { apiEvidenceId, workerEvidenceId } = CONTRADICTION_FIXTURE_META;

function knownEvidenceIdsFromInput() {
  return new Set(CONTRADICTION_FIXTURE_INPUT.evidence.map((item) => item.id));
}

describe("handoff packet — contradiction_split_service_failure fixture", () => {
  it("builds a packet that satisfies every §9 invariant", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).not.toThrow();
  });

  it("translates UNCLEAR + REQUEST_INPUT to {confidence: low, mode: collect_evidence, mayCommit: false}", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    expect(packet.read.confidence).toBe("low");
    expect(packet.nextStep.mode).toBe("collect_evidence");
    expect(packet.policy.mayCommit).toBe(false);
    expect(packet.policy.mayOpenPr).toBe(false);
    expect(packet.policy.evidenceBasedOnly).toBe(true);
  });

  it("omits every evidence id that is not real for the case (invariant 1)", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    for (const item of packet.evidence) {
      expect([apiEvidenceId, workerEvidenceId]).toContain(item.id);
    }
  });

  it("never references evidence by UUID in the rendered markdown (spec §6.1)", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const markdown = renderPacketMarkdown(packet);
    expect(markdown).not.toContain(apiEvidenceId);
    expect(markdown).not.toContain(workerEvidenceId);
  });

  it("commits to a headline even at low confidence (§2.3)", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    expect(packet.read.headline.length).toBeGreaterThan(0);
    expect(packet.read.headline.length).toBeLessThanOrEqual(240);
  });

  it("preserves newlines inside evidence excerpts (logs stay readable)", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    // Each log-like evidence item had its raw text span multiple lines; after
    // the §1.6 fix the excerpt must keep those lines instead of collapsing
    // them into a single unreadable line.
    for (const item of packet.evidence) {
      expect(
        item.excerpt,
        `evidence ${item.name} should have an excerpt`
      ).toBeTruthy();
      expect(
        item.excerpt?.includes("\n"),
        `evidence ${item.name} excerpt should preserve newlines`
      ).toBe(true);
    }
  });

  it("renders stack frames as separate lines inside code fences", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const markdown = renderPacketMarkdown(packet);
    // Code fences are indented 3 spaces; the frame's own leading whitespace
    // survives clipPreservingStructure, so we assert only that the frame is
    // isolated on its own line (not joined to the previous line).
    expect(markdown).toMatch(
      /\n\s+at submitCheckout \(\/srv\/checkout\.js:44:9\)\n/
    );
    expect(markdown).toMatch(
      /\n\s+at runWorker \(\/srv\/worker\.js:12:2\)\n/
    );
  });

  it("does not leak TARG vocabulary into the rendered markdown (§12)", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const markdown = renderPacketMarkdown(packet);
    const forbidden = [
      "UNCLEAR",
      "REQUEST_INPUT",
      "DOCTRINE",
      "QUICK_PATCH",
      "UX_UI",
      "NEEDS_REVIEW",
      "analysisRunId",
      "breakdownId",
      "claimKey",
    ];
    for (const token of forbidden) {
      expect(markdown, `markdown should not contain "${token}"`).not.toContain(
        token
      );
    }
  });

  it("renders the canonical markdown with the locked shape", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const markdown = renderPacketMarkdown(packet);
    // Snapshot-bound: any builder/renderer change that drifts this output
    // must be reviewed and the snapshot regenerated in the same commit.
    expect(markdown).toMatchSnapshot("canonical-markdown.md");
  });

  it("renders the structured packet shape deterministically", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    expect(packet).toMatchSnapshot("packet.json");
  });
});

describe("repo enrichment rendering (Phase 2.3)", () => {
  it("emits a GitHub blob URL for the affected area when repoContext carries a ref", () => {
    const enriched = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeefcafebabedeadbeefcafebabedeadbeef",
        affectedAreaLocation: {
          file: "src/lib/checkout-service.ts",
          line: 42,
        },
      },
    });
    const markdown = renderPacketMarkdown(enriched);
    expect(markdown).toContain(
      "[`src/lib/checkout-service.ts:42`](https://github.com/acme/checkout/blob/deadbeefcafebabedeadbeefcafebabedeadbeef/src/lib/checkout-service.ts#L42)"
    );
  });

  it("renders per-evidence repoLocations under each item as a nested bullet list", () => {
    const enriched = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef",
        evidenceLocations: {
          [apiEvidenceId]: [
            { file: "src/lib/api/checkout.ts", line: 10 },
            { file: "src/lib/api/checkout.ts", line: 44 },
          ],
        },
      },
    });
    const markdown = renderPacketMarkdown(enriched);
    expect(markdown).toContain(
      "   - In repo: [`src/lib/api/checkout.ts:10`](https://github.com/acme/checkout/blob/deadbeef/src/lib/api/checkout.ts#L10)"
    );
    expect(markdown).toContain(
      "   - In repo: [`src/lib/api/checkout.ts:44`](https://github.com/acme/checkout/blob/deadbeef/src/lib/api/checkout.ts#L44)"
    );
  });

  it("emits a Repo context section with tree link + stack locations", () => {
    const enriched = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "abcdef1234567890abcdef1234567890abcdef12",
        stackLocations: [
          { file: "src/lib/checkout.ts", line: 42 },
          { file: "src/lib/worker.ts", line: 12 },
        ],
      },
    });
    const markdown = renderPacketMarkdown(enriched);
    expect(markdown).toContain("## Repo context");
    expect(markdown).toContain(
      "**Repo:** [acme/checkout@abcdef1](https://github.com/acme/checkout/tree/abcdef1234567890abcdef1234567890abcdef12)"
    );
    expect(markdown).toContain(
      "[`src/lib/checkout.ts:42`](https://github.com/acme/checkout/blob/abcdef1234567890abcdef1234567890abcdef12/src/lib/checkout.ts#L42)"
    );
    expect(markdown).toContain(
      "[`src/lib/worker.ts:12`](https://github.com/acme/checkout/blob/abcdef1234567890abcdef1234567890abcdef12/src/lib/worker.ts#L12)"
    );
  });

  it("falls back to plain backticks when a RepoLocation has no enclosing repoContext", () => {
    // A CLI-driven packet that sets RepoLocation directly but not repoContext.
    const packet = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoContext: undefined,
    });
    // Inject a location into affected area via a post-build mutation — we're
    // exercising the renderer contract, not the builder here.
    const mutated = {
      ...packet,
      read: {
        ...packet.read,
        affectedArea: {
          ...packet.read.affectedArea,
          repoLocation: { file: "src/lib/foo.ts", line: 10 },
        },
      },
    };
    const markdown = renderPacketMarkdown(mutated);
    expect(markdown).toContain("`src/lib/foo.ts:10`");
    expect(markdown).not.toContain("https://github.com/");
  });

  it("percent-encodes reserved chars in path segments but keeps slashes when building blob URLs", () => {
    const enriched = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef",
        affectedAreaLocation: {
          // Next.js route-group + dynamic-segment syntax: parens are
          // unreserved per encodeURIComponent's spec (kept verbatim), but
          // square brackets are reserved and MUST be encoded for GitHub.
          file: "src/app/(app)/cases/[caseId]/page.tsx",
          line: 7,
        },
      },
    });
    const markdown = renderPacketMarkdown(enriched);
    expect(markdown).toContain(
      "https://github.com/acme/checkout/blob/deadbeef/src/app/(app)/cases/%5BcaseId%5D/page.tsx#L7"
    );
    // Path separators must NEVER be encoded — GitHub rejects %2F in blob URLs.
    expect(markdown).not.toContain("src%2Fapp");
  });

  it("omits the #Lnn suffix when the location has no line number", () => {
    const enriched = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "main",
        affectedAreaLocation: { file: "src/lib/foo.ts" },
      },
    });
    const markdown = renderPacketMarkdown(enriched);
    expect(markdown).toContain(
      "[`src/lib/foo.ts`](https://github.com/acme/checkout/blob/main/src/lib/foo.ts)"
    );
    expect(markdown).not.toMatch(/src\/lib\/foo\.ts#L/);
  });
});

describe("cursor target rendering (spec §7.1)", () => {
  it("prepends the TARG preamble and appends the agent-instructions block", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const cursorBody = renderForCursor(packet);
    expect(cursorBody.startsWith("You are triaging a bug via TARG.")).toBe(true);
    expect(cursorBody).toContain("## Instructions for the agent");
    expect(cursorBody).toContain(
      "If confidence is low, investigate only — do not commit."
    );
  });

  it("produces a URL-encodable body that fits under the 6 KB Cursor budget after truncation", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const truncated = truncatePacketToBudget(
      packet,
      knownEvidenceIdsFromInput(),
      { maxBytes: 3_500 }
    );
    const cursorBody = renderForCursor(truncated.packet);
    const url = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(cursorBody)}`;
    // 6 KB hard ceiling from the spec; leave some slack for receivers.
    expect(url.length).toBeLessThan(6_000);
  });
});

describe("confidence translation (spec §8)", () => {
  it("LIKELY + FIX => high / implement / mayCommit=true", () => {
    expect(translateConfidence("likely", "fix")).toEqual({
      confidence: "high",
      mayCommit: true,
      mayOpenPr: true,
      mode: "implement",
    });
  });

  it("LIKELY + VERIFY => high / investigate / mayCommit=false", () => {
    expect(translateConfidence("likely", "verify")).toEqual({
      confidence: "high",
      mayCommit: false,
      mayOpenPr: false,
      mode: "investigate",
    });
  });

  it("PLAUSIBLE + any => medium / not implement / mayCommit=false", () => {
    for (const action of ["fix", "verify", "request_input"] as const) {
      const out = translateConfidence("plausible", action);
      expect(out.confidence).toBe("medium");
      expect(out.mayCommit).toBe(false);
      expect(out.mode).not.toBe("implement");
    }
  });

  it("UNCLEAR + any => low / never implement / mayCommit=false", () => {
    for (const action of ["fix", "verify", "request_input"] as const) {
      const out = translateConfidence("unclear", action);
      expect(out.confidence).toBe("low");
      expect(out.mayCommit).toBe(false);
      expect(out.mode).not.toBe("implement");
    }
  });
});

describe("invariants (spec §9)", () => {
  it("rejects a packet whose evidence id is not in the case", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    // Invariant 1: hallucinated evidence id.
    const shouldThrow = () =>
      assertPacketValid(packet, new Set(["ev_unknown_only"]));
    expect(shouldThrow).toThrow(HandoffPacketInvariantError);
  });

  it("rejects a packet whose meta.caseUrl is not absolute", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const mutated = { ...packet, meta: { ...packet.meta, caseUrl: "/cases/x" } };
    expect(() =>
      assertPacketValid(mutated, knownEvidenceIdsFromInput())
    ).toThrow(/case_url_absolute/);
  });

  it("rejects a packet whose mayCommit=true without high/implement", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const mutated = {
      ...packet,
      policy: { ...packet.policy, mayCommit: true },
    };
    expect(() =>
      assertPacketValid(mutated, knownEvidenceIdsFromInput())
    ).toThrow(/commit_requires/);
  });
});

describe("truncation (spec §10)", () => {
  it("is a no-op when the packet already fits the budget", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const result = truncatePacketToBudget(
      packet,
      knownEvidenceIdsFromInput(),
      { maxBytes: 10_000_000 }
    );
    expect(result.steps).toEqual([]);
    expect(result.usedMinimalPacket).toBe(false);
  });

  it("falls back to the minimal packet at very low budgets, preserving invariants", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const result = truncatePacketToBudget(
      packet,
      knownEvidenceIdsFromInput(),
      { maxBytes: 400 }
    );
    // Minimal packet may or may not fit the byte budget depending on the
    // source material, but either way it must still be a valid packet.
    expect(() =>
      assertPacketValid(result.packet, knownEvidenceIdsFromInput())
    ).not.toThrow();
    if (result.usedMinimalPacket) {
      expect(result.packet.evidence).toHaveLength(0);
    }
  });

  it("builds a minimal packet that still satisfies invariants by itself", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    const minimal = buildMinimalPacket(packet);
    expect(() =>
      assertPacketValid(minimal, knownEvidenceIdsFromInput())
    ).not.toThrow();
    expect(minimal.evidence).toHaveLength(0);
    expect(minimal.nextStep.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(minimal.read.headline.length).toBeGreaterThan(0);
  });
});

describe("target wrappers", () => {
  it("appendAgentInstructions adds exactly one agent-instructions block", () => {
    const wrapped = appendAgentInstructions("# Already has content\n");
    expect(wrapped.match(/## Instructions for the agent/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2.5 — blame + suspected regressions rendering
//
// These tests assert the user-visible format that packet consumers rely on.
// We build a minimal packet input, inject Phase 2.5 enrichment data, and
// snapshot / regex the rendered output.
// ---------------------------------------------------------------------------

describe("phase 2.5 — blame rendering", () => {
  function buildPacketWithBlame() {
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        affectedAreaLocation: {
          file: "src/lib/checkout.ts",
          line: 42,
          blame: {
            author: "alice",
            commitSha: "abc123def456",
            commitMessage: "fix: null check in checkout",
            prNumber: 842,
            date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          },
        },
        stackLocations: [
          {
            file: "src/lib/checkout.ts",
            line: 42,
            blame: {
              author: "alice",
              commitSha: "abc123def456",
              commitMessage: "fix: null check in checkout",
              prNumber: 842,
              date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            },
          },
        ],
        evidenceLocations: {
          [apiEvidenceId]: [
            {
              file: "src/lib/checkout.ts",
              line: 42,
              blame: {
                author: "bob",
                commitSha: "def789abc012",
                commitMessage: "refactor: extract helper",
                date: new Date(Date.now() - 10 * 86_400_000).toISOString(),
              },
            },
          ],
        },
        suspectedRegressions: [
          {
            sha: "abc123def456aaaa",
            message: "fix: null check in checkout (#842)",
            author: "alice",
            date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            prNumber: 842,
            url: "https://github.com/acme/checkout/commit/abc123def456aaaa",
            touchedFiles: ["src/lib/checkout.ts", "src/lib/payments.ts"],
          },
        ],
      },
    });
  }

  it("adds a compact blame chip to the affected-area line", () => {
    const packet = buildPacketWithBlame();
    const markdown = renderPacketMarkdown(packet);
    // `_(@alice · #842 · 2 days ago)_`
    expect(markdown).toMatch(/@alice\s+·\s+#842\s+·\s+\d+\s+days?\s+ago/);
    // Must appear inside the Best current read section (before ## Evidence).
    const bestReadSection = markdown
      .split("## Evidence")[0]
      .split("## Best current read")[1] ?? "";
    expect(bestReadSection).toContain("@alice");
    expect(bestReadSection).toContain("#842");
  });

  it("appends full blame to each '- In repo:' evidence bullet", () => {
    const packet = buildPacketWithBlame();
    const markdown = renderPacketMarkdown(packet);
    expect(markdown).toMatch(
      /- In repo:.*last changed in commit def789a by @bob/
    );
  });

  it("appends full blame to each stack-location bullet in repo context", () => {
    const packet = buildPacketWithBlame();
    const markdown = renderPacketMarkdown(packet);
    expect(markdown).toMatch(
      /last changed in #842 by @alice, \d+ days? ago: "fix: null check in checkout"/
    );
  });

  it("renders suspected regressions with linked PR, author, recency, and touched files", () => {
    const packet = buildPacketWithBlame();
    const markdown = renderPacketMarkdown(packet);
    expect(markdown).toContain("- Suspected recent regressions:");
    // Nested bullet shape:
    //   - [#842](https://github.com/.../pull/842) · @alice · 2 days ago — "..." — touched `src/...`, `src/...`
    expect(markdown).toMatch(
      /\[#842\]\(https:\/\/github\.com\/acme\/checkout\/pull\/842\)\s+·\s+@alice/
    );
    expect(markdown).toContain("`src/lib/checkout.ts`");
    expect(markdown).toContain("`src/lib/payments.ts`");
  });

  it("omits blame surfaces entirely when enrichment didn't attach blame", () => {
    // Vanilla fixture has no enrichment — the output must be free of blame chips.
    const markdown = renderPacketMarkdown(buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT));
    expect(markdown).not.toMatch(/last changed in/);
    expect(markdown).not.toContain("Suspected recent regressions");
  });
});

describe("phase 2.5 — invariants", () => {
  function packetWithBlame(blameOverrides: Record<string, unknown> = {}) {
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        affectedAreaLocation: {
          file: "src/lib/checkout.ts",
          line: 42,
          blame: {
            author: "alice",
            commitSha: "abc123",
            commitMessage: "fix",
            date: new Date().toISOString(),
            ...blameOverrides,
          },
        },
      },
    });
  }

  it("rejects a packet whose blame has an empty author", () => {
    const packet = packetWithBlame({ author: "   " });
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/repo_location_blame_author_required/);
  });

  it("rejects a packet whose blame has a non-positive prNumber", () => {
    const packet = packetWithBlame({ prNumber: 0 });
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/repo_location_blame_pr_positive/);
  });

  it("rejects a packet whose suspectedRegressions has no touched files", () => {
    const packet = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef",
        suspectedRegressions: [
          {
            sha: "abc",
            message: "x",
            author: "alice",
            date: new Date().toISOString(),
            touchedFiles: [],
          },
        ],
      },
    });
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/suspected_regression_files_required/);
  });
});

// ---------------------------------------------------------------------------
// Phase 2.7 — likely-culprit chip rendering + invariants
//
// The chip is a one-line callout under "Best current read" that flags the
// most-likely-regression-causing commit when culprit detection picked one.
// The matching regression in `## Repo context` also gets a "← likely
// culprit" suffix so receivers can correlate.
// ---------------------------------------------------------------------------

describe("phase 2.7 — likely-culprit rendering", () => {
  function buildPacketWithCulprit(
    overrides: {
      culpritConfidence?: "high" | "medium";
      culpritSha?: string;
      regressionPrNumber?: number;
    } = {}
  ) {
    const culpritSha = overrides.culpritSha ?? "abc123def456aaaa";
    const prNumber = overrides.regressionPrNumber ?? 842;
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        suspectedRegressions: [
          {
            sha: culpritSha,
            message: "fix: null check in checkout (#842)",
            author: "alice",
            date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            ...(prNumber > 0 ? { prNumber } : {}),
            url: `https://github.com/acme/checkout/commit/${culpritSha}`,
            touchedFiles: ["src/lib/checkout.ts"],
          },
          {
            sha: "noisecommitsha000",
            message: "chore: bump dep",
            author: "carol",
            date: new Date(Date.now() - 5 * 86_400_000).toISOString(),
            touchedFiles: ["package.json"],
          },
        ],
        likelyCulprit: {
          sha: culpritSha,
          confidence: overrides.culpritConfidence ?? "high",
          reasons: [
            'matches affected area: "checkout flow"',
            "touched 1 of 1 suspected file",
            "merged 2 days ago",
          ],
        },
      },
    });
  }

  it("renders 'Likely culprit:' chip for high-confidence picks", () => {
    const markdown = renderPacketMarkdown(buildPacketWithCulprit());
    expect(markdown).toMatch(/\*\*Likely culprit:\*\*/);
    // Linked PR + author + recency + reasons.
    expect(markdown).toMatch(
      /\[#842\]\(https:\/\/github\.com\/acme\/checkout\/pull\/842\)/
    );
    expect(markdown).toContain("@alice");
    expect(markdown).toMatch(/matches affected area/);
  });

  it("downgrades to 'Possible culprit:' for medium-confidence picks", () => {
    const markdown = renderPacketMarkdown(
      buildPacketWithCulprit({ culpritConfidence: "medium" })
    );
    expect(markdown).toMatch(/\*\*Possible culprit:\*\*/);
    expect(markdown).not.toMatch(/\*\*Likely culprit:\*\*/);
  });

  it("places the chip inside Best current read, before ## Evidence", () => {
    const markdown = renderPacketMarkdown(buildPacketWithCulprit());
    const bestReadEnd = markdown.indexOf("## Evidence");
    const culpritIdx = markdown.search(/\*\*Likely culprit:\*\*/);
    expect(culpritIdx).toBeGreaterThan(0);
    expect(culpritIdx).toBeLessThan(bestReadEnd);
  });

  it("marks the matching regression bullet with a ← culprit suffix", () => {
    const markdown = renderPacketMarkdown(buildPacketWithCulprit());
    expect(markdown).toMatch(/← \*\*likely culprit \(high\)\*\*/);
    // Only the matching one — the noise commit must NOT carry the suffix.
    const noiseLine = markdown
      .split("\n")
      .find((line) => line.includes("noisecommitsha000") || line.includes("@carol"));
    expect(noiseLine).toBeDefined();
    expect(noiseLine).not.toMatch(/← \*\*likely culprit/);
  });

  it("falls back to commit SHA in the chip when the regression has no PR number", () => {
    const markdown = renderPacketMarkdown(
      buildPacketWithCulprit({ regressionPrNumber: 0 })
    );
    // Chip uses the 7-char short SHA when no PR is available.
    expect(markdown).toMatch(/\*\*Likely culprit:\*\* \[abc123d\]/);
  });

  it("omits the chip when no culprit is set on repoContext", () => {
    // Build a packet WITHOUT enrichment.likelyCulprit but WITH regressions.
    const markdown = renderPacketMarkdown(
      buildHandoffPacket({
        ...CONTRADICTION_FIXTURE_INPUT,
        repoEnrichment: {
          repoFullName: "acme/checkout",
          ref: "deadbeef",
          suspectedRegressions: [
            {
              sha: "x",
              message: "y",
              author: "alice",
              date: new Date().toISOString(),
              touchedFiles: ["src/a.ts"],
            },
          ],
        },
      })
    );
    expect(markdown).not.toMatch(/\*\*Likely culprit:\*\*/);
    expect(markdown).not.toMatch(/\*\*Possible culprit:\*\*/);
    expect(markdown).not.toMatch(/← \*\*likely culprit/);
  });

  it("silently drops a culprit pointing at a SHA NOT in regressions (defense in depth)", () => {
    // The builder is supposed to drop dangling culprits before they reach
    // the renderer, but we double-belt-and-suspenders here so a future
    // regression in the builder can't leak orphan chips into output.
    // We construct the packet manually to bypass the builder filter.
    const packet = buildPacketWithCulprit();
    // Tamper: rewire likelyCulprit to an SHA that isn't in regressions.
    if (packet.repoContext) {
      packet.repoContext.likelyCulprit = {
        sha: "ghostshafetched",
        confidence: "high",
        reasons: ["test"],
      };
    }
    const markdown = renderPacketMarkdown(packet);
    expect(markdown).not.toMatch(/\*\*Likely culprit:\*\*/);
  });
});

describe("phase 2.7 — invariants", () => {
  function packetWithCulprit(
    culpritOverrides: Record<string, unknown> = {}
  ) {
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef",
        suspectedRegressions: [
          {
            sha: "winner",
            message: "fix",
            author: "alice",
            date: new Date().toISOString(),
            touchedFiles: ["src/a.ts"],
          },
        ],
        likelyCulprit: {
          sha: "winner",
          confidence: "high",
          reasons: ["matches"],
          ...culpritOverrides,
        },
      },
    });
  }

  it("accepts a well-formed culprit pointing at a real regression", () => {
    expect(() =>
      assertPacketValid(packetWithCulprit(), knownEvidenceIdsFromInput())
    ).not.toThrow();
  });

  // The builder filters culprits whose sha doesn't appear in regressions
  // (defense-in-depth — see invariant 11). To test the underlying
  // invariants we tamper with the packet AFTER the build step so the
  // assert-time check is what fires.
  function tamperedCulprit(
    culpritOverrides: Partial<{
      sha: unknown;
      confidence: unknown;
      reasons: unknown;
    }>
  ) {
    const packet = packetWithCulprit();
    if (packet.repoContext?.likelyCulprit) {
      packet.repoContext.likelyCulprit = {
        ...packet.repoContext.likelyCulprit,
        ...(culpritOverrides as object),
      };
    }
    return packet;
  }

  it("rejects a culprit with an empty sha", () => {
    expect(() =>
      assertPacketValid(
        tamperedCulprit({ sha: "  " }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/likely_culprit_sha_required/);
  });

  it("rejects a culprit with confidence outside {high, medium}", () => {
    expect(() =>
      assertPacketValid(
        tamperedCulprit({ confidence: "low" }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/likely_culprit_confidence_band/);
  });

  it("rejects a culprit with empty reasons", () => {
    expect(() =>
      assertPacketValid(
        tamperedCulprit({ reasons: [] }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/likely_culprit_reasons_required/);
  });

  it("rejects a culprit with a blank reason string", () => {
    expect(() =>
      assertPacketValid(
        tamperedCulprit({ reasons: ["valid", "   "] }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/likely_culprit_reasons_required/);
  });

  it("rejects a culprit whose sha doesn't match any suspectedRegression", () => {
    // Manual construction to bypass builder-side filtering.
    const packet = packetWithCulprit();
    if (packet.repoContext?.likelyCulprit) {
      packet.repoContext.likelyCulprit = {
        sha: "orphan-sha",
        confidence: "high",
        reasons: ["test"],
      };
    }
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/likely_culprit_must_match_regression/);
  });
});
