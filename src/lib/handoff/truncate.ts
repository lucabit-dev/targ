/**
 * Packet truncation (docs/handoff-packet.md §10).
 *
 * Truncation operates on the `HandoffPacket` object (not rendered text) and runs
 * steps in the defined order until the rendered output fits a target's budget.
 * Each step is a no-op if it would break an invariant from §9.
 */

import {
  assertPacketValid,
  HandoffPacketInvariantError,
  type HandoffPacket,
} from "@/lib/handoff/packet";
import { renderPacketMarkdown } from "@/lib/handoff/render-markdown";

export type TruncationBudget = {
  /** Max size of the rendered markdown, in bytes (UTF-8). */
  maxBytes: number;
};

export type TruncationResult = {
  packet: HandoffPacket;
  rendered: string;
  steps: string[];
  usedMinimalPacket: boolean;
};

function sizeInBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

type Step = {
  id: string;
  apply: (packet: HandoffPacket) => HandoffPacket | null;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tryApply(
  packet: HandoffPacket,
  apply: (packet: HandoffPacket) => HandoffPacket | null,
  knownEvidenceIds: Set<string>
): HandoffPacket | null {
  const candidate = apply(clone(packet));
  if (!candidate) return null;
  try {
    assertPacketValid(candidate, knownEvidenceIds);
  } catch (error) {
    if (error instanceof HandoffPacketInvariantError) return null;
    throw error;
  }
  return candidate;
}

function clipExcerpts(
  packet: HandoffPacket,
  maxExcerptChars: number
): HandoffPacket | null {
  let mutated = false;
  for (const item of packet.evidence) {
    if (item.excerpt && item.excerpt.length > maxExcerptChars) {
      item.excerpt = `${item.excerpt.slice(0, maxExcerptChars - 1).trimEnd()}…`;
      mutated = true;
    }
    if (item.screenshotText && item.screenshotText.length > maxExcerptChars) {
      item.screenshotText = `${item.screenshotText
        .slice(0, maxExcerptChars - 1)
        .trimEnd()}…`;
      mutated = true;
    }
  }
  return mutated ? packet : null;
}

function dropExcerptsBeyond(
  packet: HandoffPacket,
  keepTop: number
): HandoffPacket | null {
  let mutated = false;
  packet.evidence.forEach((item, index) => {
    if (index >= keepTop) {
      if (item.excerpt) {
        delete item.excerpt;
        mutated = true;
      }
      if (item.screenshotText) {
        delete item.screenshotText;
        mutated = true;
      }
    }
  });
  return mutated ? packet : null;
}

function trimArray<T>(
  array: T[] | undefined,
  keepTop: number
): { trimmed: T[]; changed: boolean } {
  if (!array || array.length <= keepTop) {
    return { trimmed: array ?? [], changed: false };
  }
  return { trimmed: array.slice(0, keepTop), changed: true };
}

function dropHypothesesBeyond(
  packet: HandoffPacket,
  keep: number
): HandoffPacket | null {
  const { trimmed, changed } = trimArray(packet.hypotheses, keep);
  if (!changed) return null;
  packet.hypotheses = trimmed;
  return packet;
}

function dropPriorsBeyond(
  packet: HandoffPacket,
  keep: number
): HandoffPacket | null {
  if (!packet.priors) return null;
  const { trimmed, changed } = trimArray(packet.priors, keep);
  if (!changed) return null;
  packet.priors = trimmed;
  return packet;
}

function dropRegressionsBeyond(
  packet: HandoffPacket,
  keep: number
): HandoffPacket | null {
  if (!packet.repoContext?.suspectedRegressions) return null;
  const { trimmed, changed } = trimArray(
    packet.repoContext.suspectedRegressions,
    keep
  );
  if (!changed) return null;
  packet.repoContext.suspectedRegressions = trimmed;
  return packet;
}

function dropEvidenceBeyond(
  packet: HandoffPacket,
  keep: number
): HandoffPacket | null {
  if (packet.evidence.length <= keep) return null;
  const keptIds = new Set(packet.evidence.slice(0, keep).map((item) => item.id));

  // Do not drop evidence still referenced by a kept hypothesis.
  for (const hypothesis of packet.hypotheses) {
    hypothesis.supportingEvidenceIds.forEach((id) => keptIds.add(id));
    hypothesis.weakenedByEvidenceIds?.forEach((id) => keptIds.add(id));
  }

  const filtered = packet.evidence.filter((item) => keptIds.has(item.id));
  if (filtered.length === packet.evidence.length) return null;
  packet.evidence = filtered;
  return packet;
}

function dropOpenQuestionsBeyond(
  packet: HandoffPacket,
  keep: number
): HandoffPacket | null {
  const { trimmed, changed } = trimArray(packet.openQuestions, keep);
  if (!changed) return null;
  packet.openQuestions = trimmed;
  return packet;
}

const TRUNCATION_STEPS: Step[] = [
  { id: "clip_excerpts_800", apply: (p) => clipExcerpts(p, 800) },
  { id: "clip_excerpts_400", apply: (p) => clipExcerpts(p, 400) },
  { id: "clip_excerpts_200", apply: (p) => clipExcerpts(p, 200) },
  { id: "drop_excerpts_beyond_5", apply: (p) => dropExcerptsBeyond(p, 5) },
  { id: "drop_hypotheses_beyond_3", apply: (p) => dropHypothesesBeyond(p, 3) },
  { id: "drop_priors_beyond_2", apply: (p) => dropPriorsBeyond(p, 2) },
  { id: "drop_regressions_beyond_3", apply: (p) => dropRegressionsBeyond(p, 3) },
  { id: "drop_evidence_beyond_5", apply: (p) => dropEvidenceBeyond(p, 5) },
  { id: "drop_open_questions_beyond_3", apply: (p) => dropOpenQuestionsBeyond(p, 3) },
];

/**
 * Build a minimal packet (§10.1). Used as the final fallback when no combination
 * of truncation steps fits the budget.
 */
export function buildMinimalPacket(packet: HandoffPacket): HandoffPacket {
  const topHypothesis = packet.hypotheses[0];
  const minimal: HandoffPacket = {
    schemaVersion: packet.schemaVersion,
    format: packet.format,
    meta: { ...packet.meta },
    problem: { title: packet.problem.title, statement: packet.problem.statement },
    read: {
      headline: packet.read.headline,
      confidence: packet.read.confidence,
      ...(packet.read.confidenceNote
        ? { confidenceNote: packet.read.confidenceNote }
        : {}),
      affectedArea: { label: packet.read.affectedArea.label },
    },
    evidence: [],
    hypotheses: topHypothesis
      ? [
          {
            title: topHypothesis.title,
            reasoning: topHypothesis.reasoning,
            confidence: topHypothesis.confidence,
            supportingEvidenceIds: [],
          },
        ]
      : [],
    openQuestions: [],
    nextStep: {
      mode: packet.nextStep.mode,
      instruction: packet.nextStep.instruction,
      // Keep at least one acceptance criterion so invariant 3 holds.
      acceptanceCriteria: packet.nextStep.acceptanceCriteria.slice(0, 1),
    },
    policy: { ...packet.policy },
  };
  return minimal;
}

export function truncatePacketToBudget(
  packet: HandoffPacket,
  knownEvidenceIds: Set<string>,
  budget: TruncationBudget
): TruncationResult {
  const steps: string[] = [];
  let current = clone(packet);
  let rendered = renderPacketMarkdown(current);

  if (sizeInBytes(rendered) <= budget.maxBytes) {
    return { packet: current, rendered, steps, usedMinimalPacket: false };
  }

  for (const step of TRUNCATION_STEPS) {
    const applied = tryApply(current, step.apply, knownEvidenceIds);
    if (!applied) continue;
    current = applied;
    rendered = renderPacketMarkdown(current);
    steps.push(step.id);
    if (sizeInBytes(rendered) <= budget.maxBytes) {
      return { packet: current, rendered, steps, usedMinimalPacket: false };
    }
  }

  const minimal = buildMinimalPacket(current);
  try {
    assertPacketValid(minimal, knownEvidenceIds);
  } catch (error) {
    if (!(error instanceof HandoffPacketInvariantError)) throw error;
    // If the minimal packet somehow violates invariants (e.g. empty acceptance
    // criteria), fall back to the last valid current packet.
    return {
      packet: current,
      rendered,
      steps: [...steps, "minimal_packet_rejected"],
      usedMinimalPacket: false,
    };
  }
  rendered = renderPacketMarkdown(minimal);
  steps.push("minimal_packet");
  return { packet: minimal, rendered, steps, usedMinimalPacket: true };
}
