/**
 * Handoff Packet — the sole artifact TARG produces for external receivers
 * (Cursor, Claude Code, Codex, GitHub, Linear, Markdown).
 *
 * Source of truth: docs/handoff-packet.md (v1.0). Any change here that diverges
 * from the spec must update the spec in the same commit.
 *
 * This module is pure and has no Prisma / Next / fetch dependencies on purpose —
 * it is the contract layer. The service layer maps TargCase + TargDiagnosisSnapshot
 * + TargEvidence rows onto `HandoffPacketInput`, and this module builds + validates.
 */

import type {
  DiagnosisClaimReference,
  DiagnosisHypothesis,
  DiagnosisSnapshotViewModel,
} from "@/lib/analysis/view-model";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";

// ---------------------------------------------------------------------------
// 1. HandoffPacket data model (docs/handoff-packet.md §5)
// ---------------------------------------------------------------------------

export const HANDOFF_PACKET_SCHEMA_VERSION = 1 as const;
export const HANDOFF_PACKET_FORMAT = "targ.handoff" as const;

export type HandoffConfidence = "high" | "medium" | "low";
export type HandoffNextStepMode =
  | "implement"
  | "investigate"
  | "collect_evidence";

export type HandoffPacket = {
  schemaVersion: typeof HANDOFF_PACKET_SCHEMA_VERSION;
  format: typeof HANDOFF_PACKET_FORMAT;

  meta: {
    caseId: string;
    caseUrl: string;
    generatedAt: string;
    generatorVersion: string;
  };

  problem: {
    title: string;
    statement: string;
    severity?: "low" | "medium" | "high" | "critical";
    tags?: string[];
  };

  read: {
    headline: string;
    confidence: HandoffConfidence;
    confidenceNote?: string;
    affectedArea: {
      label: string;
      repoLocation?: RepoLocation;
      service?: string;
      endpoint?: string;
      surface?: string;
    };
  };

  evidence: HandoffEvidenceItem[];
  hypotheses: HandoffHypothesis[];
  openQuestions: string[];

  nextStep: {
    mode: HandoffNextStepMode;
    instruction: string;
    acceptanceCriteria: string[];
  };

  repoContext?: {
    repoFullName: string;
    ref: string;
    stackLocations?: RepoLocation[];
    suspectedRegressions?: CommitRef[];
  };

  priors?: PriorCase[];

  policy: {
    mayCommit: boolean;
    mayOpenPr: boolean;
    evidenceBasedOnly: true;
  };
};

export type HandoffEvidenceItem = {
  id: string;
  kind: "log" | "terminal" | "error_text" | "screenshot" | "note" | "code";
  source: "upload" | "paste" | "manual_note";
  name: string;
  summary: string;
  excerpt?: string;
  screenshotText?: string;
  extracted?: {
    services?: string[];
    endpoints?: string[];
    timestamps?: string[];
    requestIds?: string[];
    stackFrames?: string[];
  };
};

export type HandoffHypothesis = {
  title: string;
  reasoning: string;
  confidence: HandoffConfidence;
  supportingEvidenceIds: string[];
  weakenedByEvidenceIds?: string[];
};

export type RepoLocation = {
  file: string;
  line?: number;
  excerpt?: string;
  blame?: {
    author: string;
    commitSha: string;
    commitMessage: string;
    prNumber?: number;
    date: string;
  };
};

export type CommitRef = {
  sha: string;
  message: string;
  author: string;
  date: string;
  prNumber?: number;
  url?: string;
  touchedFiles: string[];
};

export type PriorCase = {
  caseId: string;
  title: string;
  similarity: number;
  resolutionRootCause: string;
  resolutionSummary: string;
  resolvedAt: string;
};

// ---------------------------------------------------------------------------
// 2. Builder input — the neutral shape the service layer provides (§11 mapping)
// ---------------------------------------------------------------------------

/**
 * Input to `buildHandoffPacket`. Deliberately shaped around domain view models
 * (not Prisma rows) so the builder stays portable and testable.
 */
export type HandoffPacketInput = {
  caseRecord: {
    id: string;
    title: string;
    userProblemStatement: string;
    severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
    problemLens: string | null;
    solveMode: string | null;
  };
  diagnosis: DiagnosisSnapshotViewModel;
  evidence: EvidenceViewModel[];
  repoContext?: HandoffPacket["repoContext"];
  priors?: PriorCase[];
  generator: {
    caseUrl: string;
    generatorVersion: string;
    now?: Date;
  };
};

// ---------------------------------------------------------------------------
// 3. Confidence translation (§8)
// ---------------------------------------------------------------------------

type DiagnosisConfidenceLower = "likely" | "plausible" | "unclear";
type DiagnosisNextActionModeLower = "fix" | "verify" | "request_input";

function toDiagnosisConfidence(value: string): DiagnosisConfidenceLower {
  const lower = value.toLowerCase();
  if (lower === "likely" || lower === "plausible" || lower === "unclear") {
    return lower;
  }
  return "unclear";
}

function toNextActionMode(value: string): DiagnosisNextActionModeLower {
  const lower = value.toLowerCase();
  if (lower === "fix" || lower === "verify" || lower === "request_input") {
    return lower;
  }
  return "request_input";
}

export function translateConfidence(
  diagnosisConfidence: string,
  nextActionMode: string
): {
  confidence: HandoffConfidence;
  mayCommit: boolean;
  mayOpenPr: boolean;
  mode: HandoffNextStepMode;
} {
  const confidence = toDiagnosisConfidence(diagnosisConfidence);
  const action = toNextActionMode(nextActionMode);

  if (confidence === "likely" && action === "fix") {
    return {
      confidence: "high",
      mayCommit: true,
      mayOpenPr: true,
      mode: "implement",
    };
  }

  if (confidence === "likely") {
    return {
      confidence: "high",
      mayCommit: false,
      mayOpenPr: false,
      mode: "investigate",
    };
  }

  if (confidence === "plausible") {
    return {
      confidence: "medium",
      mayCommit: false,
      mayOpenPr: false,
      mode: action === "request_input" ? "collect_evidence" : "investigate",
    };
  }

  return {
    confidence: "low",
    mayCommit: false,
    mayOpenPr: false,
    mode: action === "request_input" ? "collect_evidence" : "investigate",
  };
}

// ---------------------------------------------------------------------------
// 4. Builder (§11 mapping)
// ---------------------------------------------------------------------------

const EXCERPT_LIMIT_DEFAULT = 1200;
const SUMMARY_LIMIT = 180;
const HEADLINE_LIMIT = 240;

function clip(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) {
    return compact;
  }
  const slice = compact.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()}…`;
}

/**
 * Clip a blob of text to `max` chars **without collapsing newlines**.
 *
 * Used for evidence excerpts and OCR screenshot text, where line structure
 * carries meaning (log timestamps, stack frames, terminal prompts, OCR rows).
 * Horizontal runs of spaces/tabs are still collapsed, and blank-line runs are
 * capped at a single blank line, so heavily-indented logs do not blow the
 * budget on whitespace alone. When the text overruns, we prefer to break on
 * a newline, then on a space.
 */
function clipPreservingStructure(value: string, max: number): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  const slice = normalized.slice(0, max);
  const lastNewline = slice.lastIndexOf("\n");
  const lastSpace = slice.lastIndexOf(" ");
  const breakPoint = Math.max(lastNewline, lastSpace);
  const body = breakPoint > max * 0.5 ? slice.slice(0, breakPoint) : slice;
  return `${body.trimEnd()}…`;
}

function firstSentence(value: string): string {
  const match = value.match(/^(.+?[.!?])(\s|$)/);
  return (match ? match[1] : value).trim();
}

function pickEvidenceExcerpt(evidence: EvidenceViewModel): string | undefined {
  const text = evidence.redactedText ?? evidence.rawText ?? null;
  if (!text) {
    const screenshotText =
      (evidence.extracted as Record<string, unknown> | null)?.[
        "screenshotText"
      ];
    if (typeof screenshotText === "string" && screenshotText.trim().length > 0) {
      return clipPreservingStructure(screenshotText, EXCERPT_LIMIT_DEFAULT);
    }
    return undefined;
  }
  return clipPreservingStructure(text, EXCERPT_LIMIT_DEFAULT);
}

function extractArrayOfStrings(
  extracted: Record<string, unknown> | null,
  key: string
): string[] | undefined {
  if (!extracted) return undefined;
  const value = extracted[key];
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((item): item is string => typeof item === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function extractStackFrameLines(
  extracted: Record<string, unknown> | null
): string[] | undefined {
  if (!extracted) return undefined;
  const frames = extracted["stackFrames"];
  if (!Array.isArray(frames)) return undefined;
  const lines = frames
    .map((frame) => {
      if (typeof frame === "string") return frame;
      if (
        frame &&
        typeof frame === "object" &&
        "raw" in frame &&
        typeof (frame as { raw: unknown }).raw === "string"
      ) {
        return (frame as { raw: string }).raw;
      }
      return null;
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, 20);
  return lines.length > 0 ? lines : undefined;
}

function buildEvidenceItem(
  evidence: EvidenceViewModel
): HandoffEvidenceItem {
  const extracted = evidence.extracted ?? null;
  const item: HandoffEvidenceItem = {
    id: evidence.id,
    kind: evidence.kind,
    source: evidence.source,
    name: evidence.originalName,
    summary: clip(evidence.summary ?? `${evidence.kind} evidence`, SUMMARY_LIMIT),
  };

  const excerpt = pickEvidenceExcerpt(evidence);
  if (excerpt) item.excerpt = excerpt;

  const screenshotText = extracted
    ? (extracted["screenshotText"] as string | null | undefined)
    : undefined;
  if (typeof screenshotText === "string" && screenshotText.trim().length > 0) {
    item.screenshotText = clipPreservingStructure(
      screenshotText,
      EXCERPT_LIMIT_DEFAULT
    );
  }

  const extractedOut: NonNullable<HandoffEvidenceItem["extracted"]> = {};
  const services = extractArrayOfStrings(extracted, "services");
  const endpoints = extractArrayOfStrings(extracted, "endpoints");
  const timestamps = extractArrayOfStrings(extracted, "timestamps");
  const requestIds = extractArrayOfStrings(extracted, "requestIds");
  const stackFrames = extractStackFrameLines(extracted);
  if (services) extractedOut.services = services;
  if (endpoints) extractedOut.endpoints = endpoints;
  if (timestamps) extractedOut.timestamps = timestamps;
  if (requestIds) extractedOut.requestIds = requestIds;
  if (stackFrames) extractedOut.stackFrames = stackFrames;
  if (Object.keys(extractedOut).length > 0) item.extracted = extractedOut;

  return item;
}

function deriveHypothesisSupport(
  hypothesis: DiagnosisHypothesis,
  claimReferences: DiagnosisClaimReference[],
  evidence: EvidenceViewModel[]
): { supportingEvidenceIds: string[]; weakenedByEvidenceIds?: string[] } {
  // Heuristic link: the investigator stages produce a `claimKey` per trace entry
  // but hypotheses themselves do not carry explicit evidence links yet. We pair
  // by shared keywords between the hypothesis title + reasoning and each claim's
  // `summary` / `claimText`, then resolve to evidence ids via the claim reference.
  const haystack = `${hypothesis.title} ${hypothesis.reasoning}`.toLowerCase();
  const tokens = Array.from(
    new Set(
      haystack
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4)
    )
  );

  const scoreReference = (reference: DiagnosisClaimReference) => {
    const refText = `${reference.claimText} ${reference.summary ?? ""}`.toLowerCase();
    return tokens.reduce(
      (score, token) => score + (refText.includes(token) ? 1 : 0),
      0
    );
  };

  const scored = claimReferences
    .map((reference) => ({ reference, score: scoreReference(reference) }))
    .filter((entry) => entry.score > 0 && entry.reference.evidenceId)
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const supporting: string[] = [];
  const weakened: string[] = [];
  for (const { reference } of scored) {
    const evidenceId = reference.evidenceId!;
    if (seen.has(evidenceId)) continue;
    if (!evidence.some((item) => item.id === evidenceId)) continue;
    seen.add(evidenceId);
    if (reference.relation === "weakens") {
      weakened.push(evidenceId);
    } else {
      supporting.push(evidenceId);
    }
  }

  const result: {
    supportingEvidenceIds: string[];
    weakenedByEvidenceIds?: string[];
  } = { supportingEvidenceIds: supporting };
  if (weakened.length > 0) result.weakenedByEvidenceIds = weakened;
  return result;
}

function buildHypothesis(
  hypothesis: DiagnosisHypothesis,
  claimReferences: DiagnosisClaimReference[],
  evidence: EvidenceViewModel[]
): HandoffHypothesis {
  const links = deriveHypothesisSupport(hypothesis, claimReferences, evidence);
  return {
    title: clip(hypothesis.title, 120),
    reasoning: clip(hypothesis.reasoning, 400),
    confidence: mapHypothesisConfidence(hypothesis.confidence),
    supportingEvidenceIds: links.supportingEvidenceIds,
    ...(links.weakenedByEvidenceIds
      ? { weakenedByEvidenceIds: links.weakenedByEvidenceIds }
      : {}),
  };
}

function mapHypothesisConfidence(value: string): HandoffConfidence {
  const lower = value.toLowerCase();
  if (lower === "likely") return "high";
  if (lower === "plausible") return "medium";
  return "low";
}

function rephraseMissingEvidenceAsQuestion(item: string): string {
  const compact = item.replace(/\s+/g, " ").trim();
  if (!compact) return compact;
  if (compact.endsWith("?")) return compact;
  // "A full stack trace..." → "Can you share a full stack trace...?"
  if (/^(a |an |one |the )/i.test(compact)) {
    return `Can you share ${compact.charAt(0).toLowerCase()}${compact.slice(1).replace(/[.!?]+$/, "")}?`;
  }
  return `${compact.replace(/[.!?]+$/, "")}?`;
}

function deriveSeverity(
  value: string | null
): HandoffPacket["problem"]["severity"] {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (
    lower === "low" ||
    lower === "medium" ||
    lower === "high" ||
    lower === "critical"
  ) {
    return lower;
  }
  return undefined;
}

function deriveTags(
  input: HandoffPacketInput,
  evidence: EvidenceViewModel[]
): string[] {
  const tags = new Set<string>();
  if (input.caseRecord.problemLens) tags.add(input.caseRecord.problemLens);
  if (input.caseRecord.solveMode) tags.add(input.caseRecord.solveMode);

  for (const item of evidence) {
    const envHints = extractArrayOfStrings(item.extracted, "envHints");
    envHints?.forEach((hint) => tags.add(hint));
  }

  return Array.from(tags).slice(0, 8);
}

function deriveAcceptanceCriteria(params: {
  mode: HandoffNextStepMode;
  affectedArea: string;
  contradictionsFirst: string | undefined;
  missingEvidenceFirst: string | undefined;
}): string[] {
  const { mode, affectedArea, contradictionsFirst, missingEvidenceFirst } = params;
  if (mode === "implement") {
    return [
      `The failing path around ${affectedArea} no longer reproduces the reported error.`,
      "Existing tests still pass, and a new test covers the regression path.",
    ];
  }
  if (mode === "investigate") {
    return [
      `A fresh reproduction confirms or rules out that ${affectedArea} is the failing boundary.`,
      "A follow-up diagnosis reaches medium confidence or higher.",
    ];
  }
  // collect_evidence
  const asks: string[] = [];
  if (missingEvidenceFirst) {
    asks.push(
      `The packet contains the evidence described above: ${clip(
        missingEvidenceFirst,
        180
      )}`
    );
  }
  asks.push(
    contradictionsFirst
      ? `The new evidence resolves or clearly isolates: ${clip(contradictionsFirst, 180)}`
      : "The new evidence makes one of the listed hypotheses clearly more likely than the others."
  );
  asks.push("A follow-up diagnosis reaches medium confidence or higher.");
  return asks;
}

function orderEvidenceForPacket(
  built: HandoffEvidenceItem[],
  hypotheses: HandoffHypothesis[]
): HandoffEvidenceItem[] {
  const referenced = new Set<string>();
  for (const hypothesis of hypotheses) {
    hypothesis.supportingEvidenceIds.forEach((id) => referenced.add(id));
    hypothesis.weakenedByEvidenceIds?.forEach((id) => referenced.add(id));
  }

  const weight = (item: HandoffEvidenceItem): number => {
    if (hypotheses.some((h) => h.supportingEvidenceIds.includes(item.id))) return 0;
    if (hypotheses.some((h) => h.weakenedByEvidenceIds?.includes(item.id))) return 1;
    if ((item.extracted?.stackFrames?.length ?? 0) > 0) return 2;
    return 3;
  };

  // Drop evidence that wasn't referenced by anything and isn't a stack-bearing item.
  // Per §5.1: "Never include an item that isn't referenced by something in the packet."
  const kept = built.filter(
    (item) =>
      referenced.has(item.id) || (item.extracted?.stackFrames?.length ?? 0) > 0
  );

  // If referencing stripped everything (e.g. short case with no claim links), keep
  // the original set rather than ship an empty evidence block.
  const target = kept.length > 0 ? kept : built;

  return [...target].sort((a, b) => weight(a) - weight(b));
}

export function buildHandoffPacket(input: HandoffPacketInput): HandoffPacket {
  const now = (input.generator.now ?? new Date()).toISOString();
  const { confidence, mayCommit, mayOpenPr, mode } = translateConfidence(
    input.diagnosis.confidence,
    input.diagnosis.nextActionMode
  );

  const builtEvidence = input.evidence.map(buildEvidenceItem);
  const hypotheses = input.diagnosis.hypotheses
    .slice(0, 3)
    .map((h) => buildHypothesis(h, input.diagnosis.claimReferences, input.evidence));
  const evidence = orderEvidenceForPacket(builtEvidence, hypotheses);

  const contradictionsFirst = input.diagnosis.contradictions[0];
  const missingEvidenceFirst = input.diagnosis.missingEvidence[0];

  const openQuestions = input.diagnosis.missingEvidence
    .slice(0, 3)
    .map(rephraseMissingEvidenceAsQuestion)
    .filter(Boolean);

  const headline = clip(
    firstSentence(input.diagnosis.summary || input.diagnosis.probableRootCause),
    HEADLINE_LIMIT
  );

  const packet: HandoffPacket = {
    schemaVersion: HANDOFF_PACKET_SCHEMA_VERSION,
    format: HANDOFF_PACKET_FORMAT,

    meta: {
      caseId: input.caseRecord.id,
      caseUrl: input.generator.caseUrl,
      generatedAt: now,
      generatorVersion: input.generator.generatorVersion,
    },

    problem: {
      title: clip(input.caseRecord.title, 120),
      statement: clip(input.caseRecord.userProblemStatement, 600),
      ...(deriveSeverity(input.caseRecord.severity)
        ? { severity: deriveSeverity(input.caseRecord.severity) }
        : {}),
      ...(deriveTags(input, input.evidence).length > 0
        ? { tags: deriveTags(input, input.evidence) }
        : {}),
    },

    read: {
      headline,
      confidence,
      ...(contradictionsFirst
        ? { confidenceNote: clip(contradictionsFirst, 240) }
        : {}),
      affectedArea: {
        label: clip(input.diagnosis.affectedArea, 180),
      },
    },

    evidence,
    hypotheses,
    openQuestions,

    nextStep: {
      mode,
      instruction: clip(input.diagnosis.nextActionText, 500),
      acceptanceCriteria: deriveAcceptanceCriteria({
        mode,
        affectedArea: input.diagnosis.affectedArea,
        contradictionsFirst,
        missingEvidenceFirst,
      }),
    },

    ...(input.repoContext ? { repoContext: input.repoContext } : {}),
    ...(input.priors && input.priors.length > 0 ? { priors: input.priors } : {}),

    policy: {
      mayCommit,
      mayOpenPr,
      evidenceBasedOnly: true,
    },
  };

  return packet;
}

// ---------------------------------------------------------------------------
// 5. Invariants (§9)
// ---------------------------------------------------------------------------

export class HandoffPacketInvariantError extends Error {
  public readonly invariant: string;
  constructor(invariant: string, message: string) {
    super(`[${invariant}] ${message}`);
    this.name = "HandoffPacketInvariantError";
    this.invariant = invariant;
  }
}

const SECRET_REDACTION_MARKERS = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
];

const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{8,}/i;

export function assertPacketValid(
  packet: HandoffPacket,
  knownEvidenceIds: Set<string>
): void {
  // Invariant 1: all evidence ids are real for this case.
  for (const item of packet.evidence) {
    if (!knownEvidenceIds.has(item.id)) {
      throw new HandoffPacketInvariantError(
        "evidence_ids_exist",
        `Evidence id "${item.id}" is not part of this case.`
      );
    }
  }

  // Invariant 2: hypothesis references resolve to the packet's evidence.
  const packetEvidenceIds = new Set(packet.evidence.map((item) => item.id));
  for (const hypothesis of packet.hypotheses) {
    for (const id of hypothesis.supportingEvidenceIds) {
      if (!packetEvidenceIds.has(id)) {
        throw new HandoffPacketInvariantError(
          "hypothesis_refs_resolve",
          `Hypothesis "${hypothesis.title}" references unknown evidence id "${id}".`
        );
      }
    }
    for (const id of hypothesis.weakenedByEvidenceIds ?? []) {
      if (!packetEvidenceIds.has(id)) {
        throw new HandoffPacketInvariantError(
          "hypothesis_refs_resolve",
          `Hypothesis "${hypothesis.title}" references unknown weakening evidence id "${id}".`
        );
      }
    }
  }

  // Invariant 3: nextStep has acceptance criteria.
  if (packet.nextStep.acceptanceCriteria.length === 0) {
    throw new HandoffPacketInvariantError(
      "acceptance_criteria_required",
      "Packet is not ready: nextStep.acceptanceCriteria is empty."
    );
  }

  // Invariant 4: headline is present.
  if (packet.read.headline.trim().length === 0) {
    throw new HandoffPacketInvariantError(
      "headline_required",
      "Packet is not ready: read.headline is empty."
    );
  }

  // Invariant 5: commit-enabled packets must also be high + implement.
  if (packet.policy.mayCommit) {
    if (packet.read.confidence !== "high") {
      throw new HandoffPacketInvariantError(
        "commit_requires_high_confidence",
        `mayCommit is true but read.confidence is "${packet.read.confidence}".`
      );
    }
    if (packet.nextStep.mode !== "implement") {
      throw new HandoffPacketInvariantError(
        "commit_requires_implement_mode",
        `mayCommit is true but nextStep.mode is "${packet.nextStep.mode}".`
      );
    }
  }

  // Invariant 6: no unredacted secrets in textual content.
  const textualSurfaces: string[] = [
    packet.problem.statement,
    packet.read.headline,
    packet.read.confidenceNote ?? "",
    packet.nextStep.instruction,
    ...packet.nextStep.acceptanceCriteria,
    ...packet.openQuestions,
    ...packet.hypotheses.flatMap((h) => [h.title, h.reasoning]),
    ...packet.evidence.flatMap((item) => [
      item.summary,
      item.excerpt ?? "",
      item.screenshotText ?? "",
    ]),
  ];
  for (const surface of textualSurfaces) {
    if (!surface) continue;
    for (const pattern of SECRET_REDACTION_MARKERS) {
      if (pattern.test(surface)) {
        throw new HandoffPacketInvariantError(
          "no_unredacted_secrets",
          "Packet contains a pattern matching a known secret shape."
        );
      }
    }
    if (SECRET_ASSIGNMENT_PATTERN.test(surface)) {
      throw new HandoffPacketInvariantError(
        "no_unredacted_secrets",
        "Packet contains a pattern matching an unredacted secret assignment."
      );
    }
  }

  // Invariant 7: caseUrl is absolute.
  if (!/^https?:\/\//i.test(packet.meta.caseUrl)) {
    throw new HandoffPacketInvariantError(
      "case_url_absolute",
      `meta.caseUrl must be absolute; got "${packet.meta.caseUrl}".`
    );
  }
}
