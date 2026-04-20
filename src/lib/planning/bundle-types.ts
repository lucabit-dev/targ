/**
 * Targ-native JSON shapes for Breakdown + Work Bundle (stored as Prisma Json).
 * Version with `schemaVersion` on each persisted row; bump when fields move.
 *
 * Pipeline (append-only snapshots, no execution tracking):
 *   Case + Evidence → DiagnosisSnapshot (+ problemBrief) → TargBreakdown → TargWorkBundle
 *
 * Storage map:
 *   - Dependencies: `ArtifactDependency[]` on breakdown; `WorkBundleTaskGroup.dependsOnGroupIds`
 *     and `WorkBundleTask.dependsOnTaskIds` on bundle (ordering hints, not a task engine).
 *   - Unknowns / blockers: `UnknownItem[]` on breakdown; `blocking` flags gaps that should
 *     precede execution-style work; carried on bundle via `lineage.unknownsCarriedForward`.
 *   - Validation needs: `WorkBundleTask.acceptanceCriteria[]` (what “done” means for the step).
 *   - Evidence links: `EvidenceAnchor` (breakdown) + task `evidenceLinkIds` (anchor ids or raw
 *     evidence ids per generator contract — planning pipeline uses anchor ids when present).
 */

export type PlanningSchemaVersion = 1 | 2;

/** Evidence anchor: stable link from decomposition/bundle to TargEvidence rows. */
export type EvidenceAnchor = {
  id: string;
  evidenceId: string;
  role: "supports" | "contradicts" | "missing" | "context";
  note?: string;
};

/** Cross-artifact dependency (not Jira-style task blocking). */
export type ArtifactDependency = {
  id: string;
  fromKind: "hypothesis" | "unknown" | "section";
  fromRef: string;
  toKind: "evidence" | "hypothesis" | "unknown";
  toRef: string;
  relation: "requires" | "falsifies" | "informs";
};

export type ProblemClassification = {
  primaryMode: string;
  secondaryModes?: string[];
  experienceFacet?: "interaction" | "copy" | "mixed";
  confidence: "high" | "medium" | "low";
  rationale?: string;
};

/** Hypothesis line item keyed for bundle tasks to cite. */
export type RankedHypothesis = {
  id: string;
  text: string;
  rank: number;
  /** Mirrors diagnosis tone; bundle tasks may inherit. */
  confidence: "likely" | "plausible" | "unclear";
  linkedEvidenceAnchorIds?: string[];
};

export type UnknownItem = {
  id: string;
  text: string;
  blocks?: string[];
  /** If true, bundle should surface as “resolve before build”. */
  blocking?: boolean;
};

/** Full Breakdown document (maps to TargBreakdown columns). */
export type BreakdownDocument = {
  schemaVersion: PlanningSchemaVersion;
  problemClassification?: ProblemClassification;
  sharedSpine: Record<string, unknown>;
  modeExtensions: Record<string, unknown>;
  rankedHypotheses: RankedHypothesis[];
  unknowns: UnknownItem[];
  artifactDependencies: ArtifactDependency[];
  evidenceAnchors: EvidenceAnchor[];
};

export type WorkTaskType =
  | "research"
  | "design"
  | "implement"
  | "verify"
  | "communicate";

/** Fix-ready = scoped change acceptable; investigation-ready = learn/verify first. */
export type WorkBundleKind = "fix_ready" | "investigation_ready";

export type WorkBundleUrgency = "low" | "medium" | "high";

/** Bundle-level “why this package exists” — scannable in a few seconds. */
export type WorkBundleRationale = {
  headline: string;
  whyNow: string;
  /** What goes wrong if this is ignored or rushed. */
  primaryRisk?: string;
  /** Optional second line when two legitimate approaches exist (e.g. quick vs proper). */
  alternateApproach?: string;
};

/** Single packaged task — no assignee, due date, or status machine. */
export type WorkBundleTask = {
  id: string;
  /** Order within the section (1-based); array order is fallback. */
  order: number;
  title: string;
  type: WorkTaskType;
  objective?: string;
  /** One-line why this task exists (review surface). */
  rationale?: string;
  acceptanceCriteria: string[];
  /** Evidence anchor ids or evidence ids. */
  evidenceLinkIds: string[];
  unknownIds?: string[];
  hypothesisIds?: string[];
  /** Task-level deps on other tasks in the same bundle (ids). */
  dependsOnTaskIds?: string[];
  confidenceNote?: string;
};

/** Grouped section — ordered; dependencies between sections only (no PM graph). */
export type WorkBundleTaskGroup = {
  id: string;
  /** Display sequence (1-based). */
  order: number;
  title: string;
  objective?: string;
  /** Section-level rationale for quick review. */
  rationale?: string;
  mode?: string;
  dependsOnGroupIds: string[];
  tasks: WorkBundleTask[];
};

/** Carried forward explicitly so UI does not drop diagnosis caveats. */
export type WorkBundleLineage = {
  diagnosisSnapshotId: string;
  breakdownId: string;
  inheritedDiagnosisConfidence: "likely" | "plausible" | "unclear";
  unknownsCarriedForward: UnknownItem[];
  /** Human-readable one-liner for inspect surfaces. */
  confidenceSummary: string;
};

/** Full Work Bundle payload (maps to TargWorkBundle.payload). */
export type WorkBundlePayload = {
  schemaVersion: PlanningSchemaVersion;
  /** Primary scan line — what this bundle is for. */
  title: string;
  kind: WorkBundleKind;
  urgency: WorkBundleUrgency;
  rationale: WorkBundleRationale;
  /** One sentence on how sections chain (optional; derived from groups if omitted). */
  dependencyOverview?: string;
  lineage: WorkBundleLineage;
  taskGroups: WorkBundleTaskGroup[];
};
