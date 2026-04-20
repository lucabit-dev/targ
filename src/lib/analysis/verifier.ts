import type { DiagnosisSnapshotPayload } from "@/lib/validators";
import type { CompactCaseMemoryForVerifier } from "@/lib/analysis/draft-writer";
import type { VerifierDecisionValue } from "@/lib/analysis/constants";

export type VerifierResult = {
  shouldRun: boolean;
  decision: VerifierDecisionValue;
  diagnosis: DiagnosisSnapshotPayload;
  notes: string[];
};

function cloneDiagnosis(
  diagnosis: DiagnosisSnapshotPayload
): DiagnosisSnapshotPayload {
  return JSON.parse(JSON.stringify(diagnosis)) as DiagnosisSnapshotPayload;
}

function isHighSeverity(severity?: string | null) {
  return severity === "HIGH" || severity === "CRITICAL";
}

export function shouldRunVerifier(params: {
  severity?: string | null;
  contradictions: string[];
  nextActionMode: DiagnosisSnapshotPayload["next_action_mode"];
}) {
  return (
    isHighSeverity(params.severity) ||
    params.contradictions.length > 0 ||
    params.nextActionMode === "fix"
  );
}

export function runVerifier(params: {
  diagnosis: DiagnosisSnapshotPayload;
  caseMemory: CompactCaseMemoryForVerifier;
  severity?: string | null;
}): VerifierResult {
  const shouldRun = shouldRunVerifier({
    severity: params.severity,
    contradictions: params.diagnosis.contradictions,
    nextActionMode: params.diagnosis.next_action_mode,
  });

  if (!shouldRun) {
    return {
      shouldRun: false,
      decision: "accept",
      diagnosis: params.diagnosis,
      notes: [],
    };
  }

  const nextDiagnosis = cloneDiagnosis(params.diagnosis);
  const notes: string[] = [];
  let decision: VerifierDecisionValue = "accept";

  if (nextDiagnosis.contradictions.length > 0 && nextDiagnosis.confidence !== "unclear") {
    nextDiagnosis.confidence = "unclear";
    notes.push("Contradictions require an unclear confidence state.");
    decision = "downgrade_confidence";
  }

  if (nextDiagnosis.next_action_mode === "fix" && nextDiagnosis.confidence !== "likely") {
    nextDiagnosis.next_action_mode =
      nextDiagnosis.confidence === "unclear" ? "request_input" : "verify";
    nextDiagnosis.next_action_text =
      nextDiagnosis.confidence === "unclear"
        ? `Collect the highest-value missing evidence next: ${nextDiagnosis.missing_evidence[0] ?? "clarify the strongest conflicting signal."}`
        : `Verify the suspected failure boundary before attempting a fix: ${nextDiagnosis.affected_area}.`;
    notes.push("Implementation-style action was downgraded because confidence is below likely.");
    decision = "downgrade_next_action_mode";
  }

  if (
    isHighSeverity(params.severity) &&
    nextDiagnosis.confidence === "unclear" &&
    nextDiagnosis.next_action_mode !== "request_input"
  ) {
    nextDiagnosis.next_action_mode = "request_input";
    nextDiagnosis.next_action_text =
      "The case is high severity and still uncertain. Gather one more grounding evidence slice before attempting implementation.";
    notes.push("High-severity uncertainty requires a request-input next step.");
    decision = decision === "accept" ? "revise" : decision;
  }

  if (
    nextDiagnosis.confidence === "unclear" &&
    nextDiagnosis.contradictions.length >= 2 &&
    params.caseMemory.evidenceCounts.ready < 2
  ) {
    notes.push("Verifier blocked implementation-style draft generation due to unresolved uncertainty.");
    decision = "block";
  }

  return {
    shouldRun: true,
    decision,
    diagnosis: nextDiagnosis,
    notes,
  };
}
