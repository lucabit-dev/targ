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
