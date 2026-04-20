import type {
  ActionDraftPayload,
  DiagnosisSnapshotPayload,
} from "@/lib/validators";
import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";
import type {
  CaseProblemLensValue,
  CaseSolveModeValue,
} from "@/lib/planning/intake-preferences";

export type CompactCaseMemoryForVerifier = {
  caseId: string;
  title: string;
  userProblemStatement: string;
  solveMode?: CaseSolveModeValue | null;
  problemLens?: CaseProblemLensValue | null;
  severity?: string | null;
  evidenceCounts: {
    total: number;
    ready: number;
    needsReview: number;
    unsupported: number;
    failed: number;
  };
  commonSignals: {
    services: string[];
    endpoints: string[];
    envHints: string[];
  };
  evidence: Array<{
    id: string;
    name: string;
    summary: string | null;
  }>;
};

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function buildDraftFromDiagnosis(params: {
  diagnosis: DiagnosisSnapshotViewModel;
  caseMemory: CompactCaseMemoryForVerifier;
}): ActionDraftPayload | null {
  const { diagnosis, caseMemory } = params;

  if (diagnosis.confidence === "unclear") {
    return null;
  }

  const linkedEvidenceIds = unique(diagnosis.claimReferences.flatMap((item) =>
    item.evidenceId ? [item.evidenceId] : []
  ));

  const risksOrUnknowns = unique([
    ...diagnosis.contradictions,
    ...diagnosis.missingEvidence,
  ]).slice(0, 4);

  if (diagnosis.confidence === "likely" && diagnosis.nextActionMode === "fix") {
    return {
      type: "fix",
      title: `Stabilize ${diagnosis.affectedArea}`,
      summary: diagnosis.summary,
      whyNow:
        "The diagnosis is strong enough to attempt a focused fix without expanding scope.",
      urgency: risksOrUnknowns.length > 0 ? "high" : "medium",
      suggestedSteps: [
        `Reproduce the failure at the suspected boundary in ${diagnosis.affectedArea}.`,
        "Apply the smallest targeted change that addresses the strongest supported cause.",
        "Re-run the evidence path and confirm the contradiction set has not widened.",
      ].slice(0, 3),
      risksOrUnknowns,
      linkedEvidenceIds,
      status: "drafted",
    };
  }

  return {
    type: "investigation",
    title: `Tighten evidence around ${diagnosis.affectedArea}`,
    summary: diagnosis.summary,
    whyNow:
      diagnosis.confidence === "plausible"
        ? "The diagnosis is directionally useful, but still needs stronger grounding before implementation."
        : "The next move should gather sharper evidence instead of jumping to execution.",
    urgency: diagnosis.nextActionMode === "request_input" ? "medium" : "low",
    suggestedSteps: unique([
      diagnosis.nextActionText,
      diagnosis.missingEvidence[0] ?? "",
      caseMemory.commonSignals.endpoints[0]
        ? `Capture one fresh evidence slice around ${caseMemory.commonSignals.endpoints[0]}.`
        : "",
    ])
      .filter(Boolean)
      .slice(0, 3),
    risksOrUnknowns,
    linkedEvidenceIds,
    status: "drafted",
  };
}

export function diagnosisPayloadToViewModelLike(
  diagnosis: DiagnosisSnapshotPayload
): Pick<
  DiagnosisSnapshotViewModel,
  | "confidence"
  | "affectedArea"
  | "summary"
  | "contradictions"
  | "missingEvidence"
  | "nextActionMode"
  | "nextActionText"
  | "claimReferences"
> {
  return {
    confidence: diagnosis.confidence,
    affectedArea: diagnosis.affected_area,
    summary: diagnosis.summary,
    contradictions: diagnosis.contradictions,
    missingEvidence: diagnosis.missing_evidence,
    nextActionMode: diagnosis.next_action_mode,
    nextActionText: diagnosis.next_action_text,
    claimReferences: diagnosis.claim_references.map((item, index) => ({
      id: `temp-${index}`,
      claimKey: `trace-${index}`,
      claimText: item.claim,
      relation: "supports",
      evidenceId: item.evidenceIds[0] ?? null,
      evidenceName: null,
      sourceLabel: null,
      summary: null,
      excerpt: null,
    })),
  };
}
