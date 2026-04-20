export const ANALYSIS_RUN_STATUS_LABELS = {
  analyzing: "Analyzing",
  needs_input: "Needs input",
  ready: "Ready",
  failed: "Failed",
} as const;

export const DIAGNOSIS_CONFIDENCE_LABELS = {
  likely: "Likely",
  plausible: "Plausible",
  unclear: "Unclear",
} as const;

export const DIAGNOSIS_NEXT_ACTION_MODE_LABELS = {
  fix: "Fix",
  verify: "Verify",
  request_input: "Request input",
} as const;

export const CLAIM_REFERENCE_RELATION_LABELS = {
  supports: "Supports",
  weakens: "Weakens",
  unclear: "Unclear",
} as const;

export const ACTION_DRAFT_TYPE_LABELS = {
  fix: "Fix",
  investigation: "Investigation",
} as const;

export const ACTION_DRAFT_STATUS_LABELS = {
  drafted: "Drafted",
  saved: "Saved",
  sent: "Sent",
  dismissed: "Dismissed",
} as const;

export const VERIFIER_DECISION_LABELS = {
  accept: "Accept",
  revise: "Revise",
  block: "Block",
  downgrade_confidence: "Downgrade confidence",
  downgrade_next_action_mode: "Downgrade next action",
} as const;

export type AnalysisRunStatusValue = keyof typeof ANALYSIS_RUN_STATUS_LABELS;
export type DiagnosisConfidenceValue = keyof typeof DIAGNOSIS_CONFIDENCE_LABELS;
export type DiagnosisNextActionModeValue =
  keyof typeof DIAGNOSIS_NEXT_ACTION_MODE_LABELS;
export type ClaimReferenceRelationValue =
  keyof typeof CLAIM_REFERENCE_RELATION_LABELS;
export type ActionDraftTypeValue = keyof typeof ACTION_DRAFT_TYPE_LABELS;
export type ActionDraftStatusValue = keyof typeof ACTION_DRAFT_STATUS_LABELS;
export type VerifierDecisionValue = keyof typeof VERIFIER_DECISION_LABELS;

export const prismaAnalysisRunStatusMap: Record<AnalysisRunStatusValue, string> = {
  analyzing: "ANALYZING",
  needs_input: "NEEDS_INPUT",
  ready: "READY",
  failed: "FAILED",
};

export const prismaDiagnosisConfidenceMap: Record<
  DiagnosisConfidenceValue,
  string
> = {
  likely: "LIKELY",
  plausible: "PLAUSIBLE",
  unclear: "UNCLEAR",
};

export const prismaDiagnosisNextActionModeMap: Record<
  DiagnosisNextActionModeValue,
  string
> = {
  fix: "FIX",
  verify: "VERIFY",
  request_input: "REQUEST_INPUT",
};

export const prismaClaimReferenceRelationMap: Record<
  ClaimReferenceRelationValue,
  string
> = {
  supports: "SUPPORTS",
  weakens: "WEAKENS",
  unclear: "UNCLEAR",
};

export const prismaActionDraftTypeMap: Record<ActionDraftTypeValue, string> = {
  fix: "FIX",
  investigation: "INVESTIGATION",
};

export const prismaActionDraftStatusMap: Record<ActionDraftStatusValue, string> = {
  drafted: "DRAFTED",
  saved: "SAVED",
  sent: "SENT",
  dismissed: "DISMISSED",
};

function fromMap<T extends string>(value: string, map: Record<T, string>, fallback: T) {
  const entry = Object.entries(map).find(([, prismaValue]) => prismaValue === value);
  return (entry?.[0] as T | undefined) ?? fallback;
}

export function fromPrismaAnalysisRunStatus(value: string): AnalysisRunStatusValue {
  return fromMap(value, prismaAnalysisRunStatusMap, "analyzing");
}

export function fromPrismaDiagnosisConfidence(
  value: string
): DiagnosisConfidenceValue {
  return fromMap(value, prismaDiagnosisConfidenceMap, "plausible");
}

export function fromPrismaDiagnosisNextActionMode(
  value: string
): DiagnosisNextActionModeValue {
  return fromMap(value, prismaDiagnosisNextActionModeMap, "verify");
}

export function fromPrismaClaimReferenceRelation(
  value: string
): ClaimReferenceRelationValue {
  return fromMap(value, prismaClaimReferenceRelationMap, "unclear");
}

export function fromPrismaActionDraftType(value: string): ActionDraftTypeValue {
  return fromMap(value, prismaActionDraftTypeMap, "investigation");
}

export function fromPrismaActionDraftStatus(
  value: string
): ActionDraftStatusValue {
  return fromMap(value, prismaActionDraftStatusMap, "drafted");
}
