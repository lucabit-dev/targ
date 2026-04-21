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

  it("inserts Phase 3.0 'Where to start' before the canonical packet when repo + culprit targets resolve", () => {
    const packet = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd",
        stackLocations: [
          {
            file: "src/lib/checkout.ts",
            line: 42,
            blame: {
              author: "alice",
              commitSha: "culpritsha00000000000000000000000aa",
              commitMessage: "fix",
              date: "2026-04-01T00:00:00Z",
            },
          },
        ],
        suspectedRegressions: [
          {
            sha: "culpritsha00000000000000000000000aa",
            message: "fix",
            author: "alice",
            date: "2026-04-01T00:00:00Z",
            touchedFiles: ["src/lib/checkout.ts"],
          },
        ],
        likelyCulprit: {
          sha: "culpritsha00000000000000000000000aa",
          confidence: "high",
          reasons: ["matches affected area"],
        },
      },
    });
    const cursorBody = renderForCursor(packet);
    const whereIdx = cursorBody.indexOf("## Where to start");
    const bestReadIdx = cursorBody.indexOf("## Best current read");
    expect(whereIdx).toBeGreaterThan(-1);
    expect(bestReadIdx).toBeGreaterThan(whereIdx);
    expect(cursorBody).toContain("Cmd+P");
    expect(cursorBody).toContain("Likely culprit");
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

describe("phase 2.8 — negative-evidence rendering", () => {
  function buildPenalizedPacket(
    reasons: string[] = [
      'matches affected area: "checkout flow"',
      "touched 1 of 1 suspected file",
      "merged 1 day ago",
      "but all touched files are tests",
    ]
  ) {
    const sha = "penalizedsha0000";
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        suspectedRegressions: [
          {
            sha,
            message: "fix: checkout flow retry tests",
            author: "alice",
            date: new Date(Date.now() - 86_400_000).toISOString(),
            prNumber: 842,
            url: `https://github.com/acme/checkout/commit/${sha}`,
            touchedFiles: ["src/checkout.test.ts"],
          },
        ],
        likelyCulprit: {
          sha,
          // Negative signal fired → scoring capped confidence at medium.
          confidence: "medium",
          reasons,
        },
      },
    });
  }

  it("surfaces the negative reason in the chip even when 3 positive reasons exist", () => {
    // With four reasons and a 3-slot slice, a naive renderer would drop
    // the negative ("but all touched files are tests") bullet. The
    // renderer must prioritise negatives so the demotion rationale is
    // never hidden.
    const markdown = renderPacketMarkdown(buildPenalizedPacket());
    expect(markdown).toContain("but all touched files are tests");
  });

  it("uses 'Possible culprit' wording for penalised picks (never 'Likely')", () => {
    const markdown = renderPacketMarkdown(buildPenalizedPacket());
    expect(markdown).toMatch(/\*\*Possible culprit:\*\*/);
    expect(markdown).not.toMatch(/\*\*Likely culprit:\*\*/);
  });

  it("orders negative reasons before positives in the chip rationale", () => {
    const markdown = renderPacketMarkdown(
      buildPenalizedPacket([
        // Intentionally shuffled: scorer emits negatives last but the
        // renderer should re-order them to the front.
        'matches affected area: "checkout flow"',
        "touched 1 of 1 suspected file",
        "merged 1 day ago",
        "but contradicts scope: files are android-only",
      ])
    );
    // The rationale section is italicised and parenthesised at the end
    // of the chip line: `_(...)_`. Pull it out and verify the first
    // reason in the list is the negative one.
    const match = markdown.match(/_\(([^)]+)\)_/);
    expect(match).not.toBeNull();
    const rationaleFirst = match?.[1]?.split(" · ")[0] ?? "";
    expect(rationaleFirst.startsWith("but ")).toBe(true);
  });

  it("handles multiple negative reasons without losing positives entirely", () => {
    // When there are 2 negatives and 2 positives, with slice(0, 3):
    // negatives first → 2 negatives + 1 positive rendered.
    const markdown = renderPacketMarkdown(
      buildPenalizedPacket([
        'matches affected area: "checkout flow"',
        "touched 1 of 1 suspected file",
        "but all touched files are tests",
        "but contradicts scope: files are android-only",
      ])
    );
    expect(markdown).toContain("but all touched files are tests");
    expect(markdown).toContain("but contradicts scope");
    expect(markdown).toContain("matches affected area");
  });
});

// ---------------------------------------------------------------------------
// Phase 2.9 — diff-aware rendering
// ---------------------------------------------------------------------------

describe("phase 2.9 — diff-aware rendering", () => {
  function buildDiffPacket(reasons: string[]) {
    const sha = "diffhitsha00000000000000000000000000cafe";
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        suspectedRegressions: [
          {
            sha,
            message: "fix: null guard in submit",
            author: "alice",
            date: new Date(Date.now() - 86_400_000).toISOString(),
            prNumber: 842,
            url: `https://github.com/acme/checkout/commit/${sha}`,
            touchedFiles: ["src/checkout.ts"],
          },
        ],
        likelyCulprit: { sha, confidence: "high", reasons },
      },
    });
  }

  it("renders the diff-touches reason when the commit's diff hit a stack line", () => {
    const markdown = renderPacketMarkdown(
      buildDiffPacket([
        'matches affected area: "checkout submit"',
        "diff touches src/checkout.ts:42 (stack frame)",
        "merged 1 day ago",
      ])
    );
    expect(markdown).toContain("diff touches src/checkout.ts:42");
  });

  it("prioritises the diff-touches reason over generic positives in the chip", () => {
    // With 4 reasons + slice(0, 3): the diff hit outranks the plain
    // keyword/file/recency matches, so it must survive truncation even
    // when 3+ ordinary positives are also present.
    const markdown = renderPacketMarkdown(
      buildDiffPacket([
        'matches affected area: "checkout"',
        "touched 1 of 1 suspected file",
        "merged 1 day ago",
        "diff touches src/checkout.ts:42 (stack frame)",
      ])
    );
    expect(markdown).toContain("diff touches src/checkout.ts:42");
    // Prove it's in the rationale (italicised, parenthesised at end
    // of the chip line). The chip is wrapped to ~100 chars so the
    // rationale can span multiple physical lines — use a
    // multiline/dotall-style match via [\s\S] so `.` equivalents
    // cross newlines, and non-greedy to pin down the nearest `)_`.
    const rationale =
      markdown.match(/_\(([\s\S]+?)\)_/)?.[1].replace(/\s+/g, " ") ?? "";
    expect(rationale).toContain("diff touches src/checkout.ts:42");
  });

  it("negative reasons still outrank diff-touches reasons", () => {
    // Ordering contract: negatives > diff hits > everything else.
    const markdown = renderPacketMarkdown(
      buildDiffPacket([
        "diff touches src/checkout.ts:42 (stack frame)",
        "but all touched files are tests",
        "matches affected area",
      ])
    );
    const rationale =
      markdown.match(/_\(([\s\S]+?)\)_/)?.[1].replace(/\s+/g, " ") ?? "";
    const parts = rationale.split(" · ");
    expect(parts[0].startsWith("but ")).toBe(true);
    expect(parts[1].startsWith("diff touches")).toBe(true);
  });

  it("(2.9.1) renders near-hit reasons with ±N suffix, same priority as exact hits", () => {
    // Phase 2.9.1 reason shape for near hits includes the distance
    // in parentheses. Prefix is still "diff touches " so the
    // renderer treats it as high-priority along with exact hits.
    const markdown = renderPacketMarkdown(
      buildDiffPacket([
        "matches affected area",
        "touched 1 of 1 suspected file",
        "merged 1 day ago",
        "diff touches src/checkout.ts:42 (stack frame, ±3 lines)",
      ])
    );
    expect(markdown).toContain(
      "diff touches src/checkout.ts:42 (stack frame, ±3 lines)"
    );
    const rationale =
      markdown.match(/_\(([\s\S]+?)\)_/)?.[1].replace(/\s+/g, " ") ?? "";
    expect(rationale).toContain("±3 lines");
  });
});

// =============================================================================
// Phase 2.10 — blame × culprit rendering
// =============================================================================

describe("phase 2.10 — blame × culprit rendering", () => {
  function buildBlamePacket(reasons: string[]) {
    const sha = "blamedsha00000000000000000000000000000cafe";
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        suspectedRegressions: [
          {
            sha,
            message: "fix: cache invalidation",
            author: "alice",
            date: new Date(Date.now() - 86_400_000).toISOString(),
            prNumber: 842,
            url: `https://github.com/acme/checkout/commit/${sha}`,
            touchedFiles: ["src/cache.ts"],
          },
        ],
        likelyCulprit: { sha, confidence: "high", reasons },
      },
    });
  }

  it("renders the blame-on reason when blame cross-checks the commit", () => {
    const markdown = renderPacketMarkdown(
      buildBlamePacket([
        "matches affected area",
        "blame on src/cache.ts:42 points to this commit",
      ])
    );
    expect(markdown).toContain(
      "blame on src/cache.ts:42 points to this commit"
    );
  });

  it("blame match outranks generic positives in the chip (survives truncation)", () => {
    // Blame must be in the first 3 slots regardless of how many
    // other positives there are — it's the strongest evidence the
    // scorer can produce.
    const markdown = renderPacketMarkdown(
      buildBlamePacket([
        "matches affected area",
        "matches probable root cause",
        "touched 1 of 1 suspected file",
        "merged 1 day ago",
        "blame on src/cache.ts:42 points to this commit",
      ])
    );
    const rationale =
      markdown.match(/_\(([\s\S]+?)\)_/)?.[1].replace(/\s+/g, " ") ?? "";
    expect(rationale).toContain("blame on");
    // Blame must come before any generic positive in the joined
    // rationale — the ordering contract guarantees this.
    const parts = rationale.split(" · ");
    const blameIdx = parts.findIndex((p) => p.startsWith("blame on"));
    const areaIdx = parts.findIndex((p) => p.startsWith("matches "));
    expect(blameIdx).toBeGreaterThanOrEqual(0);
    expect(blameIdx).toBeLessThan(areaIdx);
  });

  it("ordering: negatives > blame > diff-touches > others", () => {
    // When all four kinds co-exist, the 3-slot chip must show
    // negative, then blame, then diff-touches (dropping generic
    // positives). This is the full Phase 2.8/2.9/2.10 contract.
    const markdown = renderPacketMarkdown(
      buildBlamePacket([
        "matches affected area",
        "diff touches src/cache.ts:42 (stack frame)",
        "but all touched files are tests",
        "blame on src/cache.ts:42 points to this commit",
      ])
    );
    const rationale =
      markdown.match(/_\(([\s\S]+?)\)_/)?.[1].replace(/\s+/g, " ") ?? "";
    const parts = rationale.split(" · ");
    expect(parts[0].startsWith("but ")).toBe(true);
    expect(parts[1].startsWith("blame on ")).toBe(true);
    expect(parts[2].startsWith("diff touches ")).toBe(true);
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

// =============================================================================
// Phase 2.10.1 — blame staleness rendering
// =============================================================================

describe("phase 2.10.1 — blame staleness rendering", () => {
  function buildStalenessPacket(
    staleness: NonNullable<
      NonNullable<ReturnType<typeof buildHandoffPacket>["repoContext"]>["blameStaleness"]
    >,
    options: { withCulprit?: boolean } = {}
  ) {
    const sha = "stalepacketsha00000000000000000000000cafe";
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        ...(options.withCulprit
          ? {
              suspectedRegressions: [
                {
                  sha,
                  message: "fix: unrelated thing",
                  author: "alice",
                  date: new Date(Date.now() - 86_400_000).toISOString(),
                  prNumber: 999,
                  url: `https://github.com/acme/checkout/commit/${sha}`,
                  touchedFiles: ["src/checkout.ts"],
                },
              ],
              likelyCulprit: {
                sha,
                confidence: "high",
                reasons: ["matches affected area"],
              },
            }
          : {}),
        blameStaleness: staleness,
      },
    });
  }

  it("renders a strong 'No recent culprit' note when every stack blame is stale and no culprit is picked", () => {
    const markdown = renderPacketMarkdown(
      buildStalenessPacket({
        staleCount: 3,
        totalCount: 3,
        allStaleAndUnmatched: true,
        oldest: {
          file: "src/api/handler.ts",
          line: 120,
          commitSha: "ancient",
          ageDays: 900,
          authorLogin: "founder",
        },
      })
    );
    expect(markdown).toContain("**No recent culprit:**");
    expect(markdown).not.toContain("**Together:**");
    expect(markdown).toContain("src/api/handler.ts");
    // ~30 months / ~2 years bucketing (900 days).
    expect(markdown).toMatch(/~(?:\d+ months|\d+ years) ago/);
    expect(markdown).toContain("@founder");
    // Steers the receiver — the actionable advice is the whole point.
    expect(markdown).toContain("infra");
  });

  it("renders a muted 'Blame staleness' side-note when a culprit is also present", () => {
    const markdown = renderPacketMarkdown(
      buildStalenessPacket(
        {
          staleCount: 2,
          totalCount: 3,
          allStaleAndUnmatched: false,
          oldest: {
            file: "src/util.ts",
            line: 10,
            commitSha: "old-sha",
            ageDays: 95,
            authorLogin: "alice",
          },
        },
        { withCulprit: true }
      )
    );
    // Side-note format — never undermines the culprit chip.
    expect(markdown).toContain("**Blame staleness:**");
    expect(markdown).toContain("2 of 3 stack frames");
    // Phase 2.11.1 — bridge so staleness + chips read as complementary.
    expect(markdown).toContain("**Together:**");
    expect(markdown).toContain("suspected-regression list");
    // Muted tone must NOT contain the strong steer.
    expect(markdown).not.toContain("**No recent culprit:**");
    expect(markdown).not.toContain("infra, data, config");
  });

  it("falls back to the muted side-note when allStaleAndUnmatched is true but a culprit was picked anyway", () => {
    // Edge case: the regression ranker surfaced a culprit via
    // file-hit / keyword signals even though blame on the stack
    // points elsewhere. We don't want a strong "no regression"
    // note to directly contradict the culprit chip right above it
    // — the two signals disagree and we surface both rather than
    // picking sides.
    const markdown = renderPacketMarkdown(
      buildStalenessPacket(
        {
          staleCount: 2,
          totalCount: 2,
          allStaleAndUnmatched: true,
          oldest: {
            file: "src/a.ts",
            line: 1,
            commitSha: "old",
            ageDays: 400,
            authorLogin: "bob",
          },
        },
        { withCulprit: true }
      )
    );
    expect(markdown).toContain("**Blame staleness:**");
    expect(markdown).not.toContain("**No recent culprit:**");
    expect(markdown).toContain("**Together:**");
  });

  it("singularises 'stack frame' when totalCount === 1", () => {
    const markdown = renderPacketMarkdown(
      buildStalenessPacket({
        staleCount: 1,
        totalCount: 1,
        allStaleAndUnmatched: true,
        oldest: {
          file: "src/a.ts",
          line: 42,
          commitSha: "old",
          ageDays: 45,
          authorLogin: null,
        },
      })
    );
    // 1 frame → "every stack-frame blame" works; the "N stack
    // frames" muted form is singularised, but we're in strong
    // form here. Just check we don't say "stack frames" (plural).
    expect(markdown).toContain("stack-frame blame");
    expect(markdown).not.toContain("1 stack frames");
  });

  it("surfaces 'unknown date' when the oldest blame has Infinity ageDays", () => {
    // Unparseable blame date → ageDays = Infinity. Renderer should
    // cope gracefully rather than emitting "~Infinity days ago".
    const markdown = renderPacketMarkdown(
      buildStalenessPacket({
        staleCount: 1,
        totalCount: 1,
        allStaleAndUnmatched: true,
        oldest: {
          file: "src/a.ts",
          line: 10,
          commitSha: "undated",
          ageDays: Infinity,
          authorLogin: null,
        },
      })
    );
    expect(markdown).toContain("unknown date");
    expect(markdown).not.toContain("Infinity");
  });

  it("handles missing authorLogin without emitting a stray 'by @'", () => {
    const markdown = renderPacketMarkdown(
      buildStalenessPacket({
        staleCount: 1,
        totalCount: 1,
        allStaleAndUnmatched: true,
        oldest: {
          file: "src/a.ts",
          line: 10,
          commitSha: "sha",
          ageDays: 100,
          authorLogin: null,
        },
      })
    );
    // No "by @" substring — the render path must skip the author
    // clause entirely when we don't have an attribution.
    expect(markdown).not.toContain("by @");
  });

  it("does not add the Together bridge when there is staleness but no culprit or co-culprit chips", () => {
    const markdown = renderPacketMarkdown(
      buildStalenessPacket({
        staleCount: 1,
        totalCount: 3,
        allStaleAndUnmatched: false,
        oldest: {
          file: "src/old.ts",
          line: 5,
          commitSha: "old",
          ageDays: 200,
          authorLogin: "x",
        },
      })
    );
    expect(markdown).toContain("**Blame staleness:**");
    expect(markdown).not.toContain("**Together:**");
  });

  it("Phase 2.11.1: adds Together when co-culprit chips are present (even without repeating likely culprit)", () => {
    const primarySha = "primarysha0000000000000000000000000aaa";
    const coSha = "coculp0000000000000000000000000000bbb";
    const markdown = renderPacketMarkdown(
      buildHandoffPacket({
        ...CONTRADICTION_FIXTURE_INPUT,
        repoEnrichment: {
          repoFullName: "acme/checkout",
          ref: "deadbeef0000000000000000000000000000cafe",
          suspectedRegressions: [
            {
              sha: primarySha,
              message: "fix: a",
              author: "alice",
              date: new Date(Date.now() - 86_400_000).toISOString(),
              touchedFiles: ["src/a.ts"],
            },
            {
              sha: coSha,
              message: "fix: b",
              author: "bob",
              date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
              touchedFiles: ["src/b.ts"],
            },
          ],
          likelyCulprit: {
            sha: primarySha,
            confidence: "high",
            reasons: ["matches"],
          },
          coCulprits: [
            {
              sha: coSha,
              confidence: "high",
              reasons: ["matches root cause"],
            },
          ],
          blameStaleness: {
            staleCount: 1,
            totalCount: 2,
            allStaleAndUnmatched: false,
            oldest: {
              file: "src/z.ts",
              line: 1,
              commitSha: "z-old",
              ageDays: 400,
              authorLogin: "grace",
            },
          },
        },
      })
    );
    expect(markdown).toContain("**Co-culprit:**");
    expect(markdown).toContain("**Blame staleness:**");
    expect(markdown).toContain("**Together:**");
  });

  it("emits nothing when blameStaleness is absent", () => {
    // Baseline: pre-2.10.1 packets have no staleness field and
    // should render exactly the same as before. Plain packet with
    // no repo enrichment is the simplest version of this contract.
    const markdown = renderPacketMarkdown(
      buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT)
    );
    expect(markdown).not.toContain("**No recent culprit:**");
    expect(markdown).not.toContain("**Blame staleness:**");
  });
});

// =============================================================================
// Phase 2.10.1 — blame staleness invariants
// =============================================================================

describe("phase 2.10.1 — blame staleness invariants", () => {
  function packetWithStaleness(
    override: Partial<
      NonNullable<
        NonNullable<ReturnType<typeof buildHandoffPacket>["repoContext"]>["blameStaleness"]
      >
    > = {}
  ) {
    const base = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        blameStaleness: {
          staleCount: 1,
          totalCount: 1,
          allStaleAndUnmatched: true,
          oldest: {
            file: "src/a.ts",
            line: 10,
            commitSha: "x",
            ageDays: 100,
            authorLogin: null,
          },
        },
      },
    });
    if (base.repoContext?.blameStaleness) {
      base.repoContext.blameStaleness = {
        ...base.repoContext.blameStaleness,
        ...(override as object),
      } as NonNullable<typeof base.repoContext.blameStaleness>;
    }
    return base;
  }

  it("accepts a well-formed blameStaleness summary", () => {
    expect(() =>
      assertPacketValid(packetWithStaleness(), knownEvidenceIdsFromInput())
    ).not.toThrow();
  });

  it("rejects a staleness with a non-positive staleCount", () => {
    expect(() =>
      assertPacketValid(
        packetWithStaleness({ staleCount: 0 }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/blame_staleness_count_required/);
  });

  it("rejects a staleness with totalCount < staleCount", () => {
    expect(() =>
      assertPacketValid(
        packetWithStaleness({ staleCount: 3, totalCount: 2 }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/blame_staleness_totals_coherent/);
  });

  it("rejects a staleness whose allStaleAndUnmatched flag is inconsistent with the counts", () => {
    // staleCount 2, totalCount 3 → not all-stale, but flag says
    // true. This is the foot-gun case where callers eyeballed the
    // data wrong — invariant catches it.
    expect(() =>
      assertPacketValid(
        packetWithStaleness({
          staleCount: 2,
          totalCount: 3,
          allStaleAndUnmatched: true,
        }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/blame_staleness_flag_consistent/);
  });

  it("rejects a staleness whose oldest.line is non-positive", () => {
    expect(() =>
      assertPacketValid(
        packetWithStaleness({
          oldest: {
            file: "src/a.ts",
            line: 0,
            commitSha: "x",
            ageDays: 100,
            authorLogin: null,
          },
        }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/blame_staleness_oldest_required/);
  });

  it("accepts Infinity as ageDays (undated blame)", () => {
    // Explicit: the invariant is "non-negative number", and
    // Infinity is a number (NOT NaN), so this must pass. Regression
    // guard — earlier drafts rejected Infinity.
    expect(() =>
      assertPacketValid(
        packetWithStaleness({
          oldest: {
            file: "src/a.ts",
            line: 10,
            commitSha: "x",
            ageDays: Infinity,
            authorLogin: null,
          },
        }),
        knownEvidenceIdsFromInput()
      )
    ).not.toThrow();
  });

  it("rejects NaN ageDays", () => {
    expect(() =>
      assertPacketValid(
        packetWithStaleness({
          oldest: {
            file: "src/a.ts",
            line: 10,
            commitSha: "x",
            ageDays: Number.NaN,
            authorLogin: null,
          },
        }),
        knownEvidenceIdsFromInput()
      )
    ).toThrow(/blame_staleness_age_required/);
  });
});

// =============================================================================
// Phase 2.11 — co-culprit rendering + invariants
// =============================================================================

describe("phase 2.11 — co-culprit rendering", () => {
  // Build a packet with a primary culprit + N co-culprits. Each
  // co-culprit has its own suspectedRegressions entry so the
  // renderer can resolve it back to a CommitRef.
  function buildCoCulpritPacket(
    co: Array<{
      sha: string;
      message?: string;
      author?: string;
      reasons: string[];
      touchedFiles?: string[];
    }>
  ) {
    const primarySha = "primarysha0000000000000000000000000cafe1";
    const primary = {
      sha: primarySha,
      message: "fix: primary",
      author: "alice",
      date: new Date(Date.now() - 86_400_000).toISOString(),
      prNumber: 100,
      url: `https://github.com/acme/checkout/commit/${primarySha}`,
      touchedFiles: ["src/primary.ts"],
    };
    const coRegressions = co.map((c, i) => ({
      sha: c.sha,
      message: c.message ?? `refactor co-${i}`,
      author: c.author ?? "bob",
      date: new Date(Date.now() - (i + 2) * 86_400_000).toISOString(),
      prNumber: 200 + i,
      url: `https://github.com/acme/checkout/commit/${c.sha}`,
      touchedFiles: c.touchedFiles ?? [`src/co-${i}.ts`],
    }));

    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        suspectedRegressions: [primary, ...coRegressions],
        likelyCulprit: {
          sha: primarySha,
          confidence: "high",
          reasons: ["matches affected area"],
        },
        coCulprits: co.map((c) => ({
          sha: c.sha,
          confidence: "high",
          reasons: c.reasons,
        })),
      },
    });
  }

  it("renders one **Co-culprit:** chip per entry below the primary", () => {
    const markdown = renderPacketMarkdown(
      buildCoCulpritPacket([
        {
          sha: "cosha1000000000000000000000000000000cafe",
          message: "refactor: gateway retry",
          reasons: ["matches probable root cause"],
        },
      ])
    );
    // Both chips present.
    expect(markdown).toContain("**Likely culprit:**");
    expect(markdown).toContain("**Co-culprit:**");
    // Primary comes first (order matters — primary is the headline
    // answer, co-culprit is supporting context).
    const primaryIdx = markdown.indexOf("**Likely culprit:**");
    const coIdx = markdown.indexOf("**Co-culprit:**");
    expect(primaryIdx).toBeGreaterThan(-1);
    expect(coIdx).toBeGreaterThan(primaryIdx);
  });

  it("renders multiple co-culprit chips in order when more than one qualifies", () => {
    const markdown = renderPacketMarkdown(
      buildCoCulpritPacket([
        {
          sha: "cosha1000000000000000000000000000000cafe",
          message: "refactor: gateway",
          reasons: ["matches affected area"],
        },
        {
          sha: "cosha2000000000000000000000000000000cafe",
          message: "refactor: retry helper",
          reasons: ["matches probable root cause"],
        },
      ])
    );
    const chips = markdown.match(/\*\*Co-culprit:\*\*/g) ?? [];
    expect(chips).toHaveLength(2);
    // Both distinct messages land in the output.
    expect(markdown).toContain("refactor: gateway");
    expect(markdown).toContain("refactor: retry helper");
  });

  it("tags the suspected-regressions list with '← **co-culprit**' for co-culprit rows", () => {
    // Receiver who scrolls down to the full regressions list
    // needs to match rows back to the chips at the top.
    const markdown = renderPacketMarkdown(
      buildCoCulpritPacket([
        {
          sha: "cosha1000000000000000000000000000000cafe",
          message: "refactor: gateway",
          reasons: ["matches probable root cause"],
        },
      ])
    );
    expect(markdown).toContain("← **co-culprit**");
    // Primary tag still present.
    expect(markdown).toContain("← **likely culprit");
  });

  it("applies the same reason-priority ordering as the primary chip (negatives > blame > diff > others)", () => {
    // Normally a co-culprit can't be penalised (the scorer blocks
    // those), so "but ..." reasons don't usually appear. But the
    // renderer is the source of truth for chip rendering, and it
    // should order reasons identically for symmetry with the
    // primary — future changes to the scorer rules shouldn't also
    // require renderer changes.
    const markdown = renderPacketMarkdown(
      buildCoCulpritPacket([
        {
          sha: "cosha1000000000000000000000000000000cafe",
          message: "refactor: gateway",
          reasons: [
            "matches affected area",
            "diff touches src/co.ts:10 (stack frame)",
            "blame on src/co.ts:10 points to this commit",
          ],
        },
      ])
    );
    // Extract the chip rationale, which lives inside `_(...)_`.
    const coChip = markdown.match(/\*\*Co-culprit:\*\*[\s\S]*?_\(([\s\S]+?)\)_/);
    expect(coChip).not.toBeNull();
    const rationale = coChip![1];
    // blame before diff-hit before generic positive.
    const blameIdx = rationale.indexOf("blame on");
    const diffIdx = rationale.indexOf("diff touches");
    const areaIdx = rationale.indexOf("matches affected area");
    expect(blameIdx).toBeLessThan(diffIdx);
    expect(diffIdx).toBeLessThan(areaIdx);
  });

  it("renders no Co-culprit chip when the packet has none (pre-2.11 baseline)", () => {
    // Baseline: a plain packet with no co-culprits should render
    // identically to pre-2.11 output. Regression guard against
    // accidentally emitting an empty "**Co-culprit:**" line.
    const markdown = renderPacketMarkdown(
      buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT)
    );
    expect(markdown).not.toContain("**Co-culprit:**");
    expect(markdown).not.toContain("← **co-culprit**");
  });
});

describe("phase 2.11 — co-culprit invariants", () => {
  // These tests tamper with the packet AFTER building so the
  // assert-time checks are what fires (the builder already filters
  // malformed co-culprits as defence-in-depth).
  function baseBuiltPacket(): ReturnType<typeof buildHandoffPacket> {
    const primarySha = "primarysha0000000000000000000000000cafe1";
    return buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "deadbeef0000000000000000000000000000cafe",
        suspectedRegressions: [
          {
            sha: primarySha,
            message: "fix: primary",
            author: "alice",
            date: new Date(Date.now() - 86_400_000).toISOString(),
            touchedFiles: ["src/primary.ts"],
          },
          {
            sha: "cosha1000000000000000000000000000000cafe",
            message: "refactor",
            author: "bob",
            date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            touchedFiles: ["src/co.ts"],
          },
        ],
        likelyCulprit: {
          sha: primarySha,
          confidence: "high",
          reasons: ["matches"],
        },
        coCulprits: [
          {
            sha: "cosha1000000000000000000000000000000cafe",
            confidence: "high",
            reasons: ["matches"],
          },
        ],
      },
    });
  }

  it("accepts a well-formed coCulprits list", () => {
    expect(() =>
      assertPacketValid(baseBuiltPacket(), knownEvidenceIdsFromInput())
    ).not.toThrow();
  });

  it("rejects a co-culprit with an empty sha", () => {
    const packet = baseBuiltPacket();
    packet.repoContext!.coCulprits![0] = {
      ...packet.repoContext!.coCulprits![0],
      sha: "  ",
    };
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/co_culprit_sha_required/);
  });

  it("rejects a co-culprit with confidence outside {high, medium}", () => {
    const packet = baseBuiltPacket();
    packet.repoContext!.coCulprits![0] = {
      ...packet.repoContext!.coCulprits![0],
      confidence: "low" as unknown as "high" | "medium",
    };
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/co_culprit_confidence_band/);
  });

  it("rejects a co-culprit with empty reasons", () => {
    const packet = baseBuiltPacket();
    packet.repoContext!.coCulprits![0] = {
      ...packet.repoContext!.coCulprits![0],
      reasons: [],
    };
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/co_culprit_reasons_required/);
  });

  it("rejects a co-culprit whose sha isn't in suspectedRegressions", () => {
    const packet = baseBuiltPacket();
    packet.repoContext!.coCulprits![0] = {
      ...packet.repoContext!.coCulprits![0],
      sha: "orphansha",
    };
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/co_culprit_must_match_regression/);
  });

  it("rejects a co-culprit that duplicates the primary sha", () => {
    const packet = baseBuiltPacket();
    const primarySha = packet.repoContext!.likelyCulprit!.sha;
    packet.repoContext!.coCulprits![0] = {
      ...packet.repoContext!.coCulprits![0],
      sha: primarySha,
    };
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/co_culprit_must_differ_from_primary/);
  });

  it("rejects two co-culprits with duplicate shas", () => {
    const packet = baseBuiltPacket();
    const sha = packet.repoContext!.coCulprits![0].sha;
    // Push a duplicate that points at the same commit.
    packet.repoContext!.suspectedRegressions!.push({
      ...packet.repoContext!.suspectedRegressions![1],
    });
    packet.repoContext!.coCulprits!.push({
      sha,
      confidence: "high",
      reasons: ["dup"],
    });
    expect(() =>
      assertPacketValid(packet, knownEvidenceIdsFromInput())
    ).toThrow(/co_culprit_distinct_shas/);
  });
});
