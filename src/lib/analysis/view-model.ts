import type {
  AnalysisRunStatusValue,
  ActionDraftStatusValue,
  ActionDraftTypeValue,
  ClaimReferenceRelationValue,
  DiagnosisConfidenceValue,
  DiagnosisNextActionModeValue,
} from "@/lib/analysis/constants";
import type {
  ArtifactDependency,
  EvidenceAnchor,
  ProblemClassification,
  RankedHypothesis,
  UnknownItem,
  WorkBundlePayload,
} from "@/lib/planning/bundle-types";
import type { ProblemBriefPayload } from "@/lib/analysis/problem-brief";

export type DiagnosisTraceEntry = {
  claimKey: string;
  claim: string;
  evidence: string;
};

export type DiagnosisHypothesis = {
  title: string;
  confidence: DiagnosisConfidenceValue;
  reasoning: string;
};

export type DiagnosisClaimReference = {
  id: string;
  claimKey: string;
  claimText: string;
  relation: ClaimReferenceRelationValue;
  evidenceId: string | null;
  evidenceName: string | null;
  sourceLabel: string | null;
  summary: string | null;
  excerpt: string | null;
};

export type DiagnosisSnapshotViewModel = {
  id: string;
  caseId: string;
  analysisRunId: string;
  caseEvidenceVersion: number;
  /** User-facing framing; null on legacy rows. */
  problemBrief: ProblemBriefPayload | null;
  status: "provisional" | "revised";
  confidence: DiagnosisConfidenceValue;
  probableRootCause: string;
  affectedArea: string;
  summary: string;
  trace: DiagnosisTraceEntry[];
  hypotheses: DiagnosisHypothesis[];
  contradictions: string[];
  missingEvidence: string[];
  nextActionMode: DiagnosisNextActionModeValue;
  nextActionText: string;
  claimReferences: DiagnosisClaimReference[];
  createdAt: Date | string;
};

export type AnalysisRunAnswerRecord = {
  question: string;
  options: string[];
  answer: string;
  answeredAt: string;
};

export type AnalysisRunViewModel = {
  id: string;
  caseId: string;
  createdByUserId: string;
  status: AnalysisRunStatusValue;
  questionCount: number;
  pendingQuestion: string | null;
  pendingOptions: string[];
  answers: AnalysisRunAnswerRecord[];
  caseMemory: Record<string, unknown> | null;
  failureMessage: string | null;
  latestDiagnosisId: string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type ActionDraftViewModel = {
  id: string;
  caseId: string;
  diagnosisSnapshotId: string;
  type: ActionDraftTypeValue;
  title: string;
  summary: string;
  whyNow: string;
  urgency: string;
  suggestedSteps: string[];
  risksOrUnknowns: string[];
  linkedEvidenceIds: string[];
  status: ActionDraftStatusValue;
  createdAt: Date | string;
  updatedAt: Date | string;
  savedAt: Date | string | null;
};

/** `TargBreakdown` row as a typed planning document (append-only). */
export type BreakdownViewModel = {
  id: string;
  caseId: string;
  diagnosisSnapshotId: string;
  caseEvidenceVersion: number;
  schemaVersion: number;
  problemClassification: ProblemClassification | null;
  sharedSpine: Record<string, unknown>;
  modeExtensions: Record<string, unknown>;
  rankedHypotheses: RankedHypothesis[];
  unknowns: UnknownItem[];
  artifactDependencies: ArtifactDependency[];
  evidenceAnchors: EvidenceAnchor[];
  inheritedConfidence: DiagnosisConfidenceValue | null;
  createdAt: Date | string;
};

/** `TargWorkBundle` row — packaged work guide, not execution state. */
export type WorkBundleViewModel = {
  id: string;
  caseId: string;
  diagnosisSnapshotId: string;
  breakdownId: string;
  schemaVersion: number;
  label: string | null;
  status: "generated" | "dismissed";
  payload: WorkBundlePayload;
  createdAt: Date | string;
};

export type CasePlanningArtifactsViewModel = {
  breakdown: BreakdownViewModel | null;
  workBundle: WorkBundleViewModel | null;
};
