import {
  actionDraftPayloadSchema,
  diagnosisSnapshotPayloadSchema,
} from "@/lib/validators";
import type {
  ActionDraftViewModel,
  DiagnosisSnapshotViewModel,
} from "@/lib/analysis/view-model";
import type { RunTraceRecord } from "@/lib/observability/run-trace";
import type { EvaluationDimensionScore, GoldenCase } from "@/lib/evals/types";

export type HardFailCode =
  | "invalid_diagnosis_schema"
  | "invalid_draft_schema"
  | "ignored_contradiction_in_risky_case"
  | "implementation_draft_from_unclear_diagnosis"
  | "grounding_failure_on_major_claims";

export type CaseEvaluationResult = {
  caseId: string;
  category: GoldenCase["category"];
  scores: EvaluationDimensionScore;
  hardFails: HardFailCode[];
  pass: boolean;
  notes: string[];
  weaknessDimensions: Array<keyof EvaluationDimensionScore>;
};

function average(values: number[]) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function keywordsMatch(text: string, keywords: string[]) {
  const haystack = text.toLowerCase();
  const matches = keywords.filter((keyword) =>
    haystack.includes(keyword.toLowerCase())
  );
  return matches.length / keywords.length;
}

function diagnosisToSchemaInput(diagnosis: DiagnosisSnapshotViewModel) {
  return {
    status: diagnosis.status,
    confidence: diagnosis.confidence,
    probable_root_cause: diagnosis.probableRootCause,
    affected_area: diagnosis.affectedArea,
    summary: diagnosis.summary,
    trace: diagnosis.trace.map((item) => ({
      claim: item.claim,
      evidence: item.evidence,
    })),
    hypotheses: diagnosis.hypotheses,
    contradictions: diagnosis.contradictions,
    missing_evidence: diagnosis.missingEvidence,
    next_action_mode: diagnosis.nextActionMode,
    next_action_text: diagnosis.nextActionText,
    claim_references: diagnosis.trace.map((item) => ({
      claim: item.claim,
      evidenceIds: diagnosis.claimReferences
        .filter((reference) => reference.claimKey === item.claimKey)
        .flatMap((reference) => (reference.evidenceId ? [reference.evidenceId] : [])),
    })),
  };
}

function draftToSchemaInput(draft: ActionDraftViewModel) {
  return {
    type: draft.type,
    title: draft.title,
    summary: draft.summary,
    whyNow: draft.whyNow,
    urgency: draft.urgency,
    suggestedSteps: draft.suggestedSteps,
    risksOrUnknowns: draft.risksOrUnknowns,
    linkedEvidenceIds: draft.linkedEvidenceIds,
    status: draft.status,
  };
}

export function evaluateCaseRun(params: {
  goldenCase: GoldenCase;
  trace: RunTraceRecord;
  diagnosis: DiagnosisSnapshotViewModel | null;
  draft: ActionDraftViewModel | null;
}): CaseEvaluationResult {
  const { goldenCase, trace, diagnosis, draft } = params;
  const hardFails: HardFailCode[] = [];
  const notes: string[] = [];

  const diagnosisSchemaValid = diagnosis
    ? diagnosisSnapshotPayloadSchema.safeParse(diagnosisToSchemaInput(diagnosis)).success
    : false;
  const draftSchemaValid = draft
    ? actionDraftPayloadSchema.safeParse(draftToSchemaInput(draft)).success
    : true;

  if (!diagnosisSchemaValid) {
    hardFails.push("invalid_diagnosis_schema");
    notes.push("Diagnosis payload failed schema validation.");
  }

  if (!draftSchemaValid) {
    hardFails.push("invalid_draft_schema");
    notes.push("Draft payload failed schema validation.");
  }

  if (
    goldenCase.expected.riskyContradiction &&
    (!diagnosis || diagnosis.contradictions.length === 0 || diagnosis.confidence !== "unclear")
  ) {
    hardFails.push("ignored_contradiction_in_risky_case");
    notes.push("Risky contradiction case was not surfaced as unclear.");
  }

  if (diagnosis?.confidence === "unclear" && draft?.type === "fix") {
    hardFails.push("implementation_draft_from_unclear_diagnosis");
    notes.push("Unclear diagnosis should not yield a fix draft.");
  }

  const supportsForMajorClaims =
    diagnosis?.trace.map((traceItem) =>
      diagnosis.claimReferences.some(
        (reference) =>
          reference.claimKey === traceItem.claimKey &&
          reference.relation === "supports" &&
          reference.evidenceId
      )
    ) ?? [];

  if (diagnosis && supportsForMajorClaims.some((supported) => !supported)) {
    hardFails.push("grounding_failure_on_major_claims");
    notes.push("At least one major claim is missing a persisted supporting reference.");
  }

  const correctness = diagnosis
    ? Math.max(
        keywordsMatch(
          `${diagnosis.probableRootCause} ${diagnosis.summary} ${diagnosis.affectedArea}`,
          goldenCase.expected.majorClaimKeywords
        ),
        diagnosis.nextActionMode === goldenCase.expected.nextActionMode ? 0.5 : 0
      )
    : 0;

  const grounding = diagnosis
    ? average(
        diagnosis.trace.map((traceItem) =>
          diagnosis.claimReferences.some(
            (reference) =>
              reference.claimKey === traceItem.claimKey &&
              reference.relation === "supports"
          )
            ? 1
            : 0
        )
      )
    : 0;

  const uncertainty = diagnosis
    ? diagnosis.confidence === goldenCase.expected.confidence
      ? 1
      : diagnosis.confidence === "unclear" || goldenCase.expected.confidence === "unclear"
        ? 0.25
        : 0.5
    : 0;

  const questionQuality = goldenCase.expected.shouldAskQuestion
    ? trace.clarifyingQuestions.length > 0 && trace.clarifyingQuestions.length <= 2
      ? 1
      : 0
    : trace.clarifyingQuestions.length === 0
      ? 1
      : 0.25;

  const actionQuality =
    diagnosis && diagnosis.nextActionMode === goldenCase.expected.nextActionMode
      ? draft
        ? draft.type === goldenCase.expected.draftType
          ? 1
          : goldenCase.expected.draftType === "none"
            ? 0
            : 0.4
        : goldenCase.expected.draftType === "none"
          ? 1
          : 0.2
      : 0.2;

  const schemaFidelity =
    diagnosisSchemaValid && draftSchemaValid ? 1 : diagnosisSchemaValid ? 0.5 : 0;

  const efficiency =
    trace.clarifyingQuestions.length <= 2 && trace.toolCallSequence.length <= 12 ? 1 : 0.5;

  const scores: EvaluationDimensionScore = {
    correctness,
    grounding,
    uncertainty,
    questionQuality,
    actionQuality,
    schemaFidelity,
    efficiency,
  };

  const weaknessDimensions = (Object.entries(scores) as Array<
    [keyof EvaluationDimensionScore, number]
  >)
    .filter(([, value]) => value < 0.75)
    .map(([key]) => key);

  return {
    caseId: goldenCase.id,
    category: goldenCase.category,
    scores,
    hardFails,
    pass: hardFails.length === 0,
    notes,
    weaknessDimensions,
  };
}

export function buildAggregateScorecard(results: CaseEvaluationResult[]) {
  const dimensionKeys = [
    "correctness",
    "grounding",
    "uncertainty",
    "questionQuality",
    "actionQuality",
    "schemaFidelity",
    "efficiency",
  ] satisfies Array<keyof EvaluationDimensionScore>;

  const averages = Object.fromEntries(
    dimensionKeys.map((key) => [
      key,
      average(results.map((result) => result.scores[key])),
    ])
  ) as EvaluationDimensionScore;

  const hardFailCounts = results.reduce<Record<string, number>>((accumulator, result) => {
    for (const hardFail of result.hardFails) {
      accumulator[hardFail] = (accumulator[hardFail] ?? 0) + 1;
    }

    return accumulator;
  }, {});

  const weaknessCounts = results.reduce<Record<string, number>>((accumulator, result) => {
    for (const weakness of result.weaknessDimensions) {
      accumulator[weakness] = (accumulator[weakness] ?? 0) + 1;
    }

    return accumulator;
  }, {});

  const topWeaknesses = Object.entries(weaknessCounts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([dimension, count]) => ({ dimension, count }));

  return {
    totalCases: results.length,
    passCount: results.filter((result) => result.pass).length,
    failCount: results.filter((result) => !result.pass).length,
    averages,
    hardFailCounts,
    topWeaknesses,
  };
}
