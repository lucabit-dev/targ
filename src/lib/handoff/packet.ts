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
    /// "Most-likely culprit" picked by Phase 2.7 from `suspectedRegressions`
    /// by cross-referencing the LLM's `affectedArea` / `probableRootCause`
    /// keywords against each regression's commit message + touched files.
    /// Emitted only when the top-scoring candidate clears the medium
    /// confidence threshold; otherwise omitted (no chip = no culprit
    /// claim). Always references a `sha` that exists in
    /// `suspectedRegressions` — invariant 11 enforces this.
    likelyCulprit?: LikelyCulprit;
    /// Phase 2.10.1. Summary of stack-frame blame that points at
    /// commits OUTSIDE the recent-regression window. When populated,
    /// the renderer emits a note steering the receiver away from
    /// "revert the recent commit" reasoning — the stack frames were
    /// last touched long ago, so the bug is more likely to be
    /// environmental (infra/data/config change) than a recent code
    /// regression. Omitted when every stack blame is either recent
    /// or matches a suspected regression. See `BlameStaleness` for
    /// detailed semantics.
    blameStaleness?: BlameStaleness;
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
  /// Repo references derived for this evidence item by the enrichment layer
  /// (Phase 2.3). Only populated when the case is scoped to a repo and at
  /// least one hint resolved to a real file in the current snapshot. Callers
  /// that don't care about repo context can ignore this field entirely —
  /// the Markdown renderer only emits it when the enclosing packet has
  /// `repoContext.repoFullName` + `repoContext.ref` available.
  repoLocations?: RepoLocation[];
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

/// Phase 2.10.1. Describes stack-frame blame staleness for the packet.
///
/// Rationale: the regression window is short (default 30 days). If every
/// stack frame's current blame points at commits older than that, the
/// bug isn't a recent code regression — something else changed (infra,
/// data, config, traffic pattern). Surfacing this explicitly steers the
/// receiver away from "bisect recent commits" strategies that would
/// waste time.
///
/// Populated only when at least one stale-and-unmatched blame was
/// observed. "Unmatched" = the blamed sha is not in the current
/// `suspectedRegressions`. Stale blame that DOES match a regression
/// is handled by the existing Phase 2.10 blame chip (and isn't
/// counted here — it's not evidence against recency).
export type BlameStaleness = {
  /// Total number of stack-frame (file, line) blame records that
  /// were both stale (older than the staleness threshold) AND
  /// unmatched (the blamed sha isn't in `suspectedRegressions`).
  /// At least 1 when this object is populated at all.
  staleCount: number;
  /// Total number of stack-frame blame records observed (stale +
  /// fresh). Used by the renderer to say "N of M" when mixing
  /// stale and fresh blame.
  totalCount: number;
  /// `true` when EVERY observed stack-frame blame was stale AND
  /// unmatched. This is the strong signal: the renderer surfaces
  /// a prominent "probably not a recent-commit regression" note
  /// instead of a muted side-note. `false` when at least one
  /// stack frame was either fresh or matched a regression.
  allStaleAndUnmatched: boolean;
  /// Oldest stale-and-unmatched blame record, for display. Picked
  /// as the single "most surprising" attribution — if the code
  /// hasn't changed in years, that's the most emphatic evidence.
  oldest: {
    file: string;
    line: number;
    commitSha: string;
    /// Days elapsed from the blame commit's date to the packet
    /// generation time. `Infinity` for commits with unparseable
    /// dates (renderer shows "unknown date"). Always ≥ the
    /// staleness threshold.
    ageDays: number;
    /// Author login of the blamed commit, when known. `null` when
    /// the blame record lacked author info (GraphQL hiccups,
    /// historical commits). Renderer falls back to "unknown" in
    /// that case rather than omitting the attribution entirely.
    authorLogin: string | null;
  };
};

/// Phase 2.7. Points at the most-likely-regression-causing commit among the
/// `suspectedRegressions`. Carries both the pick (`sha`) and the reasoning
/// (`reasons`) so receivers can audit the heuristic — this is a guess, not
/// ground truth, and we want that visible.
export type LikelyCulprit = {
  /// SHA of the picked commit. MUST be present in
  /// `repoContext.suspectedRegressions`. Receivers can resolve the full
  /// commit metadata (author, message, PR #, files) by looking up the
  /// matching entry in `suspectedRegressions`.
  sha: string;
  /// Confidence band. We don't emit `low` — below the medium threshold the
  /// whole `likelyCulprit` field is omitted, since a low-confidence guess
  /// is worse than no guess.
  confidence: "high" | "medium";
  /// Human-readable bullets explaining why this commit was picked. Each
  /// bullet must be a non-empty string. The renderer joins them with " · "
  /// to produce the chip rationale. Example:
  ///   ["matches affected area: 'checkout flow'",
  ///    "touched 2 of 3 suspected files",
  ///    "merged 2 days ago"]
  reasons: string[];
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
  /// Manually-supplied repo context (e.g. CLI-driven runs where the caller
  /// already knows the commit SHA + stack locations). Mutually exclusive with
  /// `repoEnrichment`: if both are supplied, `repoEnrichment` wins.
  repoContext?: HandoffPacket["repoContext"];
  /// Structured enrichment produced by the Phase 2.3 enrichment layer. When
  /// present, the builder uses it to populate `read.affectedArea.repoLocation`,
  /// `repoContext.stackLocations`, and per-evidence `repoLocations`.
  repoEnrichment?: RepoEnrichmentInput;
  priors?: PriorCase[];
  generator: {
    caseUrl: string;
    generatorVersion: string;
    now?: Date;
  };
};

/// Shape consumed by `buildHandoffPacket` to enrich a packet with resolver-
/// verified repo references. Produced by `handoff-enrichment-service` at
/// request time. All fields except `repoFullName` + `ref` are optional — a
/// case whose evidence doesn't match anything in the current snapshot still
/// gets a packet, it just carries `repoContext.{repoFullName, ref}` and no
/// inline locations.
export type RepoEnrichmentInput = {
  /// `owner/repo` for rendering GitHub blob URLs.
  repoFullName: string;
  /// Commit SHA the snapshot is pinned to. MUST be a real SHA (40-hex for
  /// GitHub) so packet consumers can treat `owner/repo@ref/path#L42` as
  /// reproducible.
  ref: string;
  /// Resolved locations per evidence id. Evidence ids not present in this
  /// map simply don't get `repoLocations` populated.
  evidenceLocations?: Record<string, RepoLocation[]>;
  /// Best single resolved location for the diagnosis's affected area, if any.
  affectedAreaLocation?: RepoLocation;
  /// Aggregated stack-trace locations surfaced at the top of `repoContext`.
  /// Distinct from per-evidence locations: these are "the code worth reading
  /// first", typically derived from parsed stack frames.
  stackLocations?: RepoLocation[];
  /// Recent commits that touched the resolved files (Phase 2.5). Populated
  /// by the blame-enrichment layer, which queries GitHub's list-commits
  /// endpoint per unique file and aggregates results. Ranked by how many
  /// resolved locations each commit touched, then by recency. Feeds
  /// `repoContext.suspectedRegressions`.
  suspectedRegressions?: CommitRef[];
  /// Phase 2.7. The most-likely-culprit pick among `suspectedRegressions`.
  /// Computed by scoring each regression against the LLM's affected-area
  /// + probable-root-cause keywords. Feeds `repoContext.likelyCulprit`.
  /// Populated only when a candidate clears the medium-confidence
  /// threshold.
  likelyCulprit?: LikelyCulprit;
  /// Phase 2.10.1. Summary of stale-and-unmatched stack-frame blame.
  /// Populated by the service layer from blame on `stackLocations` (+
  /// per-evidence `evidenceLocations`). Passed through to
  /// `repoContext.blameStaleness` verbatim when at least one stale
  /// unmatched blame was observed — otherwise omitted. See
  /// `BlameStaleness` for semantics.
  blameStaleness?: BlameStaleness;
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
  evidence: EvidenceViewModel,
  repoLocations?: RepoLocation[]
): HandoffEvidenceItem {
  const extracted = evidence.extracted ?? null;
  const item: HandoffEvidenceItem = {
    id: evidence.id,
    kind: evidence.kind,
    source: evidence.source,
    name: evidence.originalName,
    summary: clip(evidence.summary ?? `${evidence.kind} evidence`, SUMMARY_LIMIT),
  };

  if (repoLocations && repoLocations.length > 0) {
    item.repoLocations = repoLocations;
  }

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

  const enrichment = input.repoEnrichment;
  const evidenceLocationMap = enrichment?.evidenceLocations ?? {};
  const builtEvidence = input.evidence.map((item) =>
    buildEvidenceItem(item, evidenceLocationMap[item.id])
  );
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
        ...(enrichment?.affectedAreaLocation
          ? { repoLocation: enrichment.affectedAreaLocation }
          : {}),
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

    ...(() => {
      if (enrichment) {
        // Prefer enrichment-provided regressions (Phase 2.5) — they're the
        // automated signal. Fall back to manually-supplied ones when the
        // enrichment layer didn't populate any (e.g. blame API failed or
        // the repo isn't connected).
        const regressions =
          enrichment.suspectedRegressions && enrichment.suspectedRegressions.length > 0
            ? enrichment.suspectedRegressions
            : input.repoContext?.suspectedRegressions;
        // Phase 2.7: only carry `likelyCulprit` through when its `sha` is
        // present in the regressions list we're actually shipping. A
        // culprit pointing at a commit we dropped would fail invariant 11
        // — better to silently omit than to corrupt the packet.
        const culprit =
          enrichment.likelyCulprit &&
          regressions?.some((r) => r.sha === enrichment.likelyCulprit!.sha)
            ? enrichment.likelyCulprit
            : undefined;
        const ctx: HandoffPacket["repoContext"] = {
          repoFullName: enrichment.repoFullName,
          ref: enrichment.ref,
          ...(enrichment.stackLocations && enrichment.stackLocations.length > 0
            ? { stackLocations: enrichment.stackLocations }
            : {}),
          ...(regressions && regressions.length > 0
            ? { suspectedRegressions: regressions }
            : {}),
          ...(culprit ? { likelyCulprit: culprit } : {}),
          // Phase 2.10.1: pass staleness through verbatim. The
          // enrichment service has already filtered to "at least 1
          // stale unmatched blame" before populating it, so if
          // present it's meaningful to render.
          ...(enrichment.blameStaleness
            ? { blameStaleness: enrichment.blameStaleness }
            : {}),
        };
        return { repoContext: ctx };
      }
      if (input.repoContext) return { repoContext: input.repoContext };
      return {};
    })(),
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

  // Invariant 8: every repo location points at a non-empty path; if `line` is
  // provided it must be a positive integer. Enrichment bugs that produce
  // `{ file: "", line: NaN }` should surface here rather than at render time.
  const allLocations: RepoLocation[] = [
    ...(packet.read.affectedArea.repoLocation
      ? [packet.read.affectedArea.repoLocation]
      : []),
    ...(packet.repoContext?.stackLocations ?? []),
    ...packet.evidence.flatMap((item) => item.repoLocations ?? []),
  ];
  for (const location of allLocations) {
    if (typeof location.file !== "string" || location.file.trim().length === 0) {
      throw new HandoffPacketInvariantError(
        "repo_location_file_required",
        "Every RepoLocation must have a non-empty `file` path."
      );
    }
    if (
      location.line !== undefined &&
      (!Number.isInteger(location.line) || location.line <= 0)
    ) {
      throw new HandoffPacketInvariantError(
        "repo_location_line_positive",
        `RepoLocation.line must be a positive integer; got ${JSON.stringify(location.line)}.`
      );
    }
    // Invariant 8b: blame metadata (Phase 2.5). Fail fast on malformed blame
    // so we don't emit half-rendered "last changed by undefined" strings.
    if (location.blame) {
      const { author, commitSha, commitMessage, date, prNumber } = location.blame;
      if (typeof author !== "string" || author.trim().length === 0) {
        throw new HandoffPacketInvariantError(
          "repo_location_blame_author_required",
          "RepoLocation.blame.author must be a non-empty string."
        );
      }
      if (typeof commitSha !== "string" || commitSha.trim().length === 0) {
        throw new HandoffPacketInvariantError(
          "repo_location_blame_sha_required",
          "RepoLocation.blame.commitSha must be a non-empty string."
        );
      }
      if (typeof commitMessage !== "string") {
        throw new HandoffPacketInvariantError(
          "repo_location_blame_message_required",
          "RepoLocation.blame.commitMessage must be a string."
        );
      }
      if (typeof date !== "string" || date.trim().length === 0) {
        throw new HandoffPacketInvariantError(
          "repo_location_blame_date_required",
          "RepoLocation.blame.date must be a non-empty string."
        );
      }
      if (
        prNumber !== undefined &&
        (!Number.isInteger(prNumber) || prNumber <= 0)
      ) {
        throw new HandoffPacketInvariantError(
          "repo_location_blame_pr_positive",
          `RepoLocation.blame.prNumber must be a positive integer; got ${JSON.stringify(prNumber)}.`
        );
      }
    }
  }

  // Invariant 9: if repoContext exists with a ref, it must be a plausible git
  // ref (SHA, branch, or tag). We accept anything non-empty that isn't obvious
  // garbage to keep the door open for future "branch head" packets.
  if (packet.repoContext) {
    const ref = packet.repoContext.ref;
    if (typeof ref !== "string" || ref.trim().length === 0) {
      throw new HandoffPacketInvariantError(
        "repo_context_ref_required",
        "repoContext.ref must be a non-empty string when repoContext is set."
      );
    }
    if (
      typeof packet.repoContext.repoFullName !== "string" ||
      !packet.repoContext.repoFullName.includes("/")
    ) {
      throw new HandoffPacketInvariantError(
        "repo_context_name_required",
        `repoContext.repoFullName must look like "owner/repo"; got "${packet.repoContext.repoFullName}".`
      );
    }

    // Invariant 10: each suspected regression CommitRef (Phase 2.5) must
    // have the core fields populated. These ship to LLM agents, so partial
    // rows would corrupt the "regression evidence" signal.
    for (const commit of packet.repoContext.suspectedRegressions ?? []) {
      if (typeof commit.sha !== "string" || commit.sha.trim().length === 0) {
        throw new HandoffPacketInvariantError(
          "suspected_regression_sha_required",
          "repoContext.suspectedRegressions[*].sha must be non-empty."
        );
      }
      if (typeof commit.author !== "string" || commit.author.trim().length === 0) {
        throw new HandoffPacketInvariantError(
          "suspected_regression_author_required",
          "repoContext.suspectedRegressions[*].author must be non-empty."
        );
      }
      if (typeof commit.date !== "string" || commit.date.trim().length === 0) {
        throw new HandoffPacketInvariantError(
          "suspected_regression_date_required",
          "repoContext.suspectedRegressions[*].date must be non-empty."
        );
      }
      if (!Array.isArray(commit.touchedFiles) || commit.touchedFiles.length === 0) {
        throw new HandoffPacketInvariantError(
          "suspected_regression_files_required",
          "repoContext.suspectedRegressions[*].touchedFiles must be a non-empty array."
        );
      }
    }

    // Invariant 11: likelyCulprit (Phase 2.7) must reference a real
    // regression and carry a non-empty reasons array. We deliberately fail
    // closed — half-formed culprits that don't map to a regression entry
    // would render as orphan chips with no audit trail.
    if (packet.repoContext.likelyCulprit) {
      const culprit = packet.repoContext.likelyCulprit;
      if (typeof culprit.sha !== "string" || culprit.sha.trim().length === 0) {
        throw new HandoffPacketInvariantError(
          "likely_culprit_sha_required",
          "repoContext.likelyCulprit.sha must be a non-empty string."
        );
      }
      if (culprit.confidence !== "high" && culprit.confidence !== "medium") {
        throw new HandoffPacketInvariantError(
          "likely_culprit_confidence_band",
          `repoContext.likelyCulprit.confidence must be "high" or "medium"; got "${culprit.confidence}".`
        );
      }
      if (!Array.isArray(culprit.reasons) || culprit.reasons.length === 0) {
        throw new HandoffPacketInvariantError(
          "likely_culprit_reasons_required",
          "repoContext.likelyCulprit.reasons must be a non-empty array."
        );
      }
      for (const reason of culprit.reasons) {
        if (typeof reason !== "string" || reason.trim().length === 0) {
          throw new HandoffPacketInvariantError(
            "likely_culprit_reasons_required",
            "Every entry in repoContext.likelyCulprit.reasons must be a non-empty string."
          );
        }
      }
      const regressions = packet.repoContext.suspectedRegressions ?? [];
      if (!regressions.some((r) => r.sha === culprit.sha)) {
        throw new HandoffPacketInvariantError(
          "likely_culprit_must_match_regression",
          `repoContext.likelyCulprit.sha "${culprit.sha}" does not match any suspectedRegressions[*].sha. The culprit must be one of the listed regressions so receivers can audit it.`
        );
      }
    }

    // Invariant 12 (Phase 2.10.1): blame staleness, when present, must
    // describe a real observation. Counts have to be coherent, the
    // "all stale" flag has to match the counts, and `oldest` needs
    // the fields the renderer relies on. Failing closed on malformed
    // staleness prevents the renderer from producing misleading
    // notices like "0 of 3 stack frames are stale" (which would be
    // actively confusing — the whole point is to be a strong hint).
    if (packet.repoContext.blameStaleness) {
      const s = packet.repoContext.blameStaleness;
      if (!Number.isInteger(s.staleCount) || s.staleCount < 1) {
        throw new HandoffPacketInvariantError(
          "blame_staleness_count_required",
          `repoContext.blameStaleness.staleCount must be a positive integer; got ${s.staleCount}. Omit the field entirely when no stale blame was observed.`
        );
      }
      if (!Number.isInteger(s.totalCount) || s.totalCount < s.staleCount) {
        throw new HandoffPacketInvariantError(
          "blame_staleness_totals_coherent",
          `repoContext.blameStaleness.totalCount (${s.totalCount}) must be an integer ≥ staleCount (${s.staleCount}).`
        );
      }
      if (typeof s.allStaleAndUnmatched !== "boolean") {
        throw new HandoffPacketInvariantError(
          "blame_staleness_flag_required",
          "repoContext.blameStaleness.allStaleAndUnmatched must be a boolean."
        );
      }
      if (s.allStaleAndUnmatched !== (s.staleCount === s.totalCount)) {
        throw new HandoffPacketInvariantError(
          "blame_staleness_flag_consistent",
          `repoContext.blameStaleness.allStaleAndUnmatched (${s.allStaleAndUnmatched}) must equal (staleCount === totalCount) (${s.staleCount === s.totalCount}).`
        );
      }
      if (
        typeof s.oldest.file !== "string" ||
        s.oldest.file.trim().length === 0 ||
        typeof s.oldest.commitSha !== "string" ||
        s.oldest.commitSha.trim().length === 0 ||
        !Number.isInteger(s.oldest.line) ||
        s.oldest.line <= 0
      ) {
        throw new HandoffPacketInvariantError(
          "blame_staleness_oldest_required",
          "repoContext.blameStaleness.oldest must have a non-empty file, a non-empty commitSha, and a positive integer line."
        );
      }
      // `ageDays` may be `Infinity` (unparseable commit date) but
      // never negative (would imply a future date which our clock
      // override allows in tests but not production).
      if (
        typeof s.oldest.ageDays !== "number" ||
        Number.isNaN(s.oldest.ageDays) ||
        s.oldest.ageDays < 0
      ) {
        throw new HandoffPacketInvariantError(
          "blame_staleness_age_required",
          `repoContext.blameStaleness.oldest.ageDays must be a non-negative number (Infinity allowed); got ${s.oldest.ageDays}.`
        );
      }
    }
  }
}
