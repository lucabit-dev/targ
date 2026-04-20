import { Prisma } from "@prisma/client";

import { buildCompactCaseMemory } from "@/lib/analysis/case-memory";
import { generateDiagnosisSnapshot } from "@/lib/analysis/diagnosis-provider";
import type { CompactCaseMemoryForVerifier } from "@/lib/analysis/draft-writer";
import { runVerifier } from "@/lib/analysis/verifier";
import { buildInvestigatorPrompt } from "@/lib/analysis/prompt";
import {
  createInvestigatorTools,
  serializeDiagnosisSnapshot,
} from "@/lib/analysis/tools";
import {
  fromPrismaAnalysisRunStatus,
  prismaAnalysisRunStatusMap,
} from "@/lib/analysis/constants";
import type {
  ActionDraftViewModel,
  AnalysisRunAnswerRecord,
  AnalysisRunViewModel,
} from "@/lib/analysis/view-model";
import {
  finalizeRunTrace,
  initializeRunTrace,
  recordTraceDraftGeneration,
  recordTraceFailure,
  recordTracePlanningResult,
  recordTraceQuestionAnswered,
  recordTraceVerifierResult,
} from "@/lib/observability/run-trace";
import { createDraftForDiagnosis } from "@/lib/services/draft-service";
import { persistPlanningAfterDiagnosis } from "@/lib/services/planning-service";
import { assertCaseAccess } from "@/lib/services/evidence-service";
import { prisma } from "@/lib/prisma";
import type {
  DiagnosisSnapshotPayload,
  RunAnswerInput,
} from "@/lib/validators";

class StaleAnalysisRunError extends Error {
  constructor() {
    super("Evidence changed during analysis. Results were discarded; run analysis again.");
    this.name = "StaleAnalysisRunError";
  }
}

function jsonArrayToStrings(value: Prisma.JsonValue | null) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseAnswers(value: Prisma.JsonValue | null): AnalysisRunAnswerRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is Prisma.JsonObject =>
        typeof item === "object" && item !== null && !Array.isArray(item)
    )
    .map((item) => ({
      question: typeof item.question === "string" ? item.question : "",
      options: Array.isArray(item.options)
        ? item.options.filter((option): option is string => typeof option === "string")
        : [],
      answer: typeof item.answer === "string" ? item.answer : "",
      answeredAt:
        typeof item.answeredAt === "string"
          ? item.answeredAt
          : new Date().toISOString(),
    }))
    .filter((item) => item.question.length > 0 && item.answer.length > 0);
}

function serializeRun(record: {
  id: string;
  caseId: string;
  createdByUserId: string;
  status: string;
  questionCount: number;
  pendingQuestion: string | null;
  pendingOptions: Prisma.JsonValue | null;
  answers: Prisma.JsonValue | null;
  caseMemory: Prisma.JsonValue | null;
  failureMessage: string | null;
  latestDiagnosisId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AnalysisRunViewModel {
  return {
    id: record.id,
    caseId: record.caseId,
    createdByUserId: record.createdByUserId,
    status: fromPrismaAnalysisRunStatus(record.status),
    questionCount: record.questionCount,
    pendingQuestion: record.pendingQuestion,
    pendingOptions: jsonArrayToStrings(record.pendingOptions),
    answers: parseAnswers(record.answers),
    caseMemory:
      record.caseMemory &&
      typeof record.caseMemory === "object" &&
      !Array.isArray(record.caseMemory)
        ? (record.caseMemory as Record<string, unknown>)
        : null,
    failureMessage: record.failureMessage,
    latestDiagnosisId: record.latestDiagnosisId,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractedSummary(extracted: Prisma.JsonValue | null) {
  if (extracted && typeof extracted === "object" && !Array.isArray(extracted)) {
    const value = (extracted as Record<string, unknown>).summary;
    return typeof value === "string" ? value : null;
  }

  return null;
}

type CompactCaseMemory = Awaited<ReturnType<typeof buildCompactCaseMemory>>;

async function assertRunStillCurrent(caseId: string, expectedEvidenceVersion: number) {
  const currentCase = await prisma.targCase.findUnique({
    where: {
      id: caseId,
    },
    select: {
      evidenceVersion: true,
    },
  });

  if (!currentCase) {
    throw new Error("Case not found.");
  }

  if (currentCase.evidenceVersion !== expectedEvidenceVersion) {
    throw new StaleAnalysisRunError();
  }
}

type AnalysisMode =
  | "experience"
  | "performance"
  | "reliability"
  | "workflow_state"
  | "product_logic"
  | "concept_doctrine"
  | "functional_defect";

function clampSentence(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > max * 0.45 ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()}…`;
}

function detectAnalysisMode(haystack: string): AnalysisMode {
  if (/\b(ui|ux|screen|button|layout|copy|text|label|tooltip|empty state|loading)\b/.test(haystack)) {
    return "experience";
  }
  if (/\b(performance|slow|latency|timeout|memory|cpu)\b/.test(haystack)) {
    return "performance";
  }
  if (/\b(workflow|state|handoff|status|permission|approval)\b/.test(haystack)) {
    return "workflow_state";
  }
  if (/\b(rule|policy|entitlement|should|calculation|price|expected)\b/.test(haystack)) {
    return "product_logic";
  }
  if (/\b(concept|doctrine|expectation|misunderstand|term)\b/.test(haystack)) {
    return "concept_doctrine";
  }
  if (/\b(flake|retry|crash|503|500|incident|error|exception)\b/.test(haystack)) {
    return "reliability";
  }
  return "functional_defect";
}

function inferUserImpact(params: {
  mode: AnalysisMode;
  affectedArea: string;
  screenshotNeedsReview: boolean;
  contradictions: string[];
}) {
  if (params.screenshotNeedsReview && params.contradictions.length === 0) {
    return `Users are likely seeing the failure clearly, but the strongest visible signal is still trapped in screenshot evidence.`;
  }

  switch (params.mode) {
    case "experience":
      return `Users are likely encountering a broken or confusing visible state around ${params.affectedArea}.`;
    case "workflow_state":
      return `The intended workflow likely breaks before completion around ${params.affectedArea}.`;
    case "product_logic":
      return "The implemented behavior may not match the product rule or expectation people rely on.";
    case "performance":
      return `People are likely feeling slowdown or timeout pressure around ${params.affectedArea}.`;
    case "concept_doctrine":
      return "Operators may be acting on the wrong interpretation of the rule, expectation, or term involved.";
    case "reliability":
      return `The path through ${params.affectedArea} likely fails hard enough to break confidence in the flow.`;
    default:
      return `The failing path around ${params.affectedArea} likely blocks intended use or completion.`;
  }
}

function buildModeAwareSummary(params: {
  mode: AnalysisMode;
  affectedArea: string;
  probableRootCause: string;
  userImpact: string;
  confidence: DiagnosisSnapshotPayload["confidence"];
  contradictions: string[];
  answerContext: string;
}) {
  const modeLead =
    params.mode === "experience"
      ? `This looks like an experience-facing issue around ${params.affectedArea}.`
      : params.mode === "product_logic" || params.mode === "workflow_state"
        ? `This looks like a product or workflow issue centered on ${params.affectedArea}.`
        : params.mode === "performance"
          ? `This looks like a performance-sensitive issue around ${params.affectedArea}.`
          : params.mode === "concept_doctrine"
            ? "This looks like a doctrine or expectation mismatch more than a pure implementation bug."
            : `This looks like an implementation-side failure centered on ${params.affectedArea}.`;

  const contradictionLine =
    params.contradictions[0]
      ? `Main tension: ${clampSentence(params.contradictions[0], 180)}`
      : null;

  return clampSentence(
    [
      modeLead,
      params.userImpact,
      `Strongest current explanation: ${params.probableRootCause}`,
      `Confidence is ${params.confidence}.`,
      contradictionLine,
      params.answerContext,
    ]
      .filter(Boolean)
      .join(" "),
    1000
  );
}

function buildModeAwareHypotheses(params: {
  mode: AnalysisMode;
  confidence: DiagnosisSnapshotPayload["confidence"];
  probableRootCause: string;
  envHints: string[];
  screenshotNeedsReview: boolean;
  contradictions: string[];
  userImpact: string;
}): DiagnosisSnapshotPayload["hypotheses"] {
  const hypotheses: DiagnosisSnapshotPayload["hypotheses"] = [];

  if (params.mode === "experience") {
    hypotheses.push({
      title: "Visible state is out of sync with the intended flow",
      confidence: params.confidence,
      reasoning: clampSentence(
        `${params.userImpact} The strongest explanation still points to ${params.probableRootCause.toLowerCase()}`,
        600
      ),
    });
  } else if (
    params.mode === "product_logic" ||
    params.mode === "workflow_state" ||
    params.mode === "concept_doctrine"
  ) {
    hypotheses.push({
      title: "Expected behavior and actual behavior have diverged",
      confidence: params.confidence,
      reasoning: clampSentence(
        `${params.userImpact} The strongest current explanation is ${params.probableRootCause.toLowerCase()}`,
        600
      ),
    });
  } else if (params.mode === "performance") {
    hypotheses.push({
      title: "The main path slows or times out at a specific boundary",
      confidence: params.confidence,
      reasoning: clampSentence(
        `${params.userImpact} The evidence clusters around ${params.probableRootCause.toLowerCase()}`,
        600
      ),
    });
  } else {
    hypotheses.push({
      title: "Implementation boundary is failing on the main path",
      confidence: params.confidence,
      reasoning: clampSentence(
        `${params.userImpact} The strongest explanation is ${params.probableRootCause.toLowerCase()}`,
        600
      ),
    });
  }

  hypotheses.push({
    title:
      params.mode === "experience"
        ? "The visible symptom may hide a different lower-level boundary"
        : "Configuration or environment mismatch is still plausible",
    confidence: params.contradictions.length > 0 ? "unclear" : "plausible",
    reasoning:
      params.envHints.length > 0
        ? clampSentence(
            `Environment hints currently include ${params.envHints.join(", ")}.`,
            600
          )
        : "The current evidence does not fully rule out a boundary outside the first suspected cause.",
  });

  if (params.screenshotNeedsReview) {
    hypotheses.push({
      title: "Important context is still trapped in screenshot evidence",
      confidence: "plausible",
      reasoning:
        "A screenshot is present but not confidently text-readable, so some support remains manual.",
    });
  }

  return hypotheses.slice(0, 5);
}

function buildModeAwareNextAction(params: {
  mode: AnalysisMode;
  nextActionMode: DiagnosisSnapshotPayload["next_action_mode"];
  affectedArea: string;
  missingEvidence: string[];
}) {
  if (params.nextActionMode === "request_input") {
    return `Add the highest-value missing evidence next: ${params.missingEvidence[0] ?? "a short clarifying note about the failure symptom."}`;
  }

  if (params.nextActionMode === "fix") {
    switch (params.mode) {
      case "experience":
        return `Start with the smallest change that restores the intended visible state around ${params.affectedArea}, then verify adjacent UI states.`;
      case "workflow_state":
      case "product_logic":
        return `Start at the failing decision boundary in ${params.affectedArea} and align the implemented behavior with the intended rule before broadening scope.`;
      case "performance":
        return `Start at the slow boundary in ${params.affectedArea} and make the smallest measurable improvement you can verify immediately.`;
      default:
        return `Start with the failing boundary in ${params.affectedArea} and reproduce the stack-bearing path with the current evidence in hand.`;
    }
  }

  switch (params.mode) {
    case "experience":
      return `Verify the broken visible state around ${params.affectedArea} with one fresh reproduction and compare it against the current screenshots, notes, and evidence summaries.`;
    case "workflow_state":
    case "product_logic":
      return `Verify the expected behavior around ${params.affectedArea} with one fresh reproduction and compare it against the current rule, state, or workflow evidence.`;
    case "performance":
      return `Verify the suspected slow boundary around ${params.affectedArea} with one timed reproduction and compare it against the current evidence summaries.`;
    default:
      return `Verify the suspected failure boundary around ${params.affectedArea} with one fresh reproduction and compare it against the current evidence summaries.`;
  }
}

function buildDiagnosisFromMemory(params: {
  caseMemory: CompactCaseMemory;
  answers: AnalysisRunAnswerRecord[];
}) {
  const { caseMemory, answers } = params;
  const evidence = caseMemory.evidence ?? [];
  const readyEvidence = evidence.filter(
    (item) => item.ingestStatus === "ready" || item.ingestStatus === "needs_review"
  );
  const services = unique(evidence.flatMap((item) => item.services ?? []));
  const endpoints = unique(evidence.flatMap((item) => item.endpoints ?? []));
  const envHints = unique(evidence.flatMap((item) => item.envHints ?? []));
  const stackFrames = evidence.flatMap((item) => item.stackFrames ?? []);
  const screenshotNeedsReview = evidence.some(
    (item) => item.kind === "screenshot" && item.ingestStatus === "needs_review"
  );
  const screenshotMissingContext = evidence.some(
    (item) =>
      item.kind === "screenshot" &&
      item.ingestStatus === "needs_review" &&
      item.contextLinked !== true
  );
  const evidenceSummaries = readyEvidence
    .map((item) => item.summary ?? item.textPreview ?? "")
    .filter(Boolean)
    .join(" ");
  const timestampCoverage = evidence.filter(
    (item) => (item.timestamps ?? []).length > 0
  ).length;

  const contradictions: string[] = [];

  if (services.length > 1) {
    contradictions.push(
      `Evidence points at multiple services (${services.join(", ")}) without one confirmed failing boundary.`
    );
  }

  if (
    envHints.includes("production") &&
    (envHints.includes("local") || envHints.includes("development") || envHints.includes("dev"))
  ) {
    contradictions.push(
      "Environment hints conflict between production and local/development contexts."
    );
  }

  if (evidence.some((item) => item.ingestStatus === "unsupported")) {
    contradictions.push(
      "Some uploaded evidence is still unsupported, so the current diagnosis is based on a partial record."
    );
  }

  if (readyEvidence.length > 1 && timestampCoverage > 0 && timestampCoverage < readyEvidence.length) {
    contradictions.push(
      "Timestamp alignment is incomplete across the current evidence set."
    );
  }

  let confidence: DiagnosisSnapshotPayload["confidence"] = "plausible";

  if (contradictions.length > 0) {
    confidence = "unclear";
  } else if (readyEvidence.length >= 2 && (stackFrames.length > 0 || services.length > 0)) {
    confidence = "likely";
  }

  const affectedArea =
    services[0] ??
    endpoints[0] ??
    (stackFrames.length > 0 ? "Application runtime" : "Case evidence surface");
  const analysisHaystack = [
    caseMemory.title,
    caseMemory.userProblemStatement,
    affectedArea,
    services.join(" "),
    endpoints.join(" "),
    evidenceSummaries,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const analysisMode = detectAnalysisMode(analysisHaystack);

  const probableRootCause =
    stackFrames.length > 0
      ? services[0]
        ? `Unhandled runtime failure inside ${services[0]}.`
        : endpoints[0]
          ? `Unhandled request failure around ${endpoints[0]}.`
          : "Unhandled runtime exception surfaced in the collected evidence."
      : screenshotMissingContext && readyEvidence.length === 1
        ? "The strongest signal is trapped in screenshot evidence that still needs manual clarification."
        : screenshotNeedsReview && readyEvidence.length === 1
          ? "The strongest signal comes from screenshot evidence supported by manual context, but it still lacks direct text extraction."
        : services[0]
          ? `Application-side fault likely centered in ${services[0]}.`
          : "The collected evidence suggests an application fault, but the root cause remains provisional.";

  const missingEvidence = unique(
    [
      stackFrames.length === 0
        ? "One full stack trace or terminal capture from the failing path."
        : "",
      evidence.flatMap((item) => item.timestamps ?? []).length === 0
        ? "A timestamped evidence slice around the failure."
        : "",
      endpoints.length > 0 &&
      evidence.flatMap((item) => item.requestIds ?? []).length === 0
        ? "A request or trace identifier that links the failure across components."
        : "",
      screenshotMissingContext
        ? "A short note describing what part of the screenshot matters most."
        : "",
      analysisMode === "product_logic" || analysisMode === "workflow_state"
        ? "A short note describing the expected behavior or rule on the failing path."
        : "",
      analysisMode === "experience"
        ? "One fresh reproduction describing the visible broken state and the intended state."
        : "",
    ].filter(Boolean)
  );

  const answerContext =
    answers.length > 0
      ? `User clarification so far: ${answers
          .map((answer) => `${answer.question} -> ${answer.answer}`)
          .join(" | ")}`
      : "";
  const userImpact = inferUserImpact({
    mode: analysisMode,
    affectedArea,
    screenshotNeedsReview: screenshotMissingContext,
    contradictions,
  });
  const summary = buildModeAwareSummary({
    mode: analysisMode,
    affectedArea,
    probableRootCause,
    userImpact,
    confidence,
    contradictions,
    answerContext,
  });

  const hypotheses = buildModeAwareHypotheses({
    mode: analysisMode,
    confidence,
    probableRootCause,
    envHints,
    screenshotNeedsReview: screenshotMissingContext,
    contradictions,
    userImpact,
  });

  const trace: DiagnosisSnapshotPayload["trace"] = readyEvidence
    .slice(0, 4)
    .map((item) => ({
      claim:
        item.summary ??
        `Evidence ${item.name} contributes to the provisional diagnosis.`,
      evidence: `${item.name} (${item.kind}, ${item.ingestStatus})`,
    }));

  const claimReferences: DiagnosisSnapshotPayload["claim_references"] = trace.map(
    (entry, index) => ({
      claim: entry.claim,
      evidenceIds: [readyEvidence[index]?.id ?? evidence[index]?.id ?? ""].filter(Boolean),
    })
  );

  const next_action_mode: DiagnosisSnapshotPayload["next_action_mode"] =
    contradictions.length > 0 || missingEvidence.length >= 2
      ? "request_input"
      : confidence === "likely"
        ? "fix"
        : "verify";

  const next_action_text = buildModeAwareNextAction({
    mode: analysisMode,
    nextActionMode: next_action_mode,
    affectedArea,
    missingEvidence,
  });

  return {
    status: answers.length === 0 ? "provisional" : "revised",
    confidence,
    probable_root_cause: probableRootCause,
    affected_area: affectedArea,
    summary,
    trace:
      trace.length > 0
        ? trace
        : [
            {
              claim: "The current diagnosis is being inferred from limited evidence.",
              evidence: "Case summary and available evidence inventory",
            },
          ],
    hypotheses,
    contradictions,
    missing_evidence: missingEvidence,
    next_action_mode,
    next_action_text,
    claim_references:
      claimReferences.length > 0
        ? claimReferences
        : [
            {
              claim: "The current diagnosis is being inferred from limited evidence.",
              evidenceIds: evidence.slice(0, 1).map((item) => item.id),
            },
          ],
  } satisfies DiagnosisSnapshotPayload;
}

/**
 * Single analysis run: understand → diagnosis snapshot → planning stack (classify, decompose,
 * work bundle, verify) → optional draft. See `src/lib/analysis/analysis-pipeline.ts` for stage IDs.
 */
async function runInvestigatorForRun(runId: string) {
  const run = await prisma.targAnalysisRun.findUnique({
    where: {
      id: runId,
    },
    select: {
      id: true,
      caseId: true,
      questionCount: true,
      answers: true,
    },
  });

  if (!run) {
    throw new Error("Run not found.");
  }

  const tools = createInvestigatorTools({
    runId,
    caseId: run.caseId,
  });

  const caseMemory = await tools.fetchCaseMemory();
  const expectedEvidenceVersion =
    typeof caseMemory.evidenceVersion === "number" ? caseMemory.evidenceVersion : null;

  const prompt = buildInvestigatorPrompt(caseMemory as Record<string, unknown>);

  await prisma.targAnalysisRun.update({
    where: {
      id: runId,
    },
    data: {
      status: prismaAnalysisRunStatusMap.analyzing as never,
      pendingQuestion: null,
      pendingOptions: Prisma.JsonNull,
      caseMemory: {
        ...(caseMemory as Record<string, unknown>),
        investigatorPrompt: prompt,
      } as Prisma.InputJsonValue,
    },
  });

  const answers = parseAnswers(run.answers);
  const evidenceList = await tools.listEvidence();
  const readyEvidenceCount = evidenceList.filter(
    (item) => item.ingestStatus === "READY" || item.ingestStatus === "NEEDS_REVIEW"
  ).length;
  const screenshotOnly =
    readyEvidenceCount > 0 &&
    evidenceList.every(
      (item) =>
        item.kind === "SCREENSHOT" ||
        item.ingestStatus === "FAILED" ||
        item.ingestStatus === "UNSUPPORTED"
    );

  if (expectedEvidenceVersion !== null) {
    await assertRunStillCurrent(run.caseId, expectedEvidenceVersion);
  }

  if (readyEvidenceCount === 0 && run.questionCount < 2 && answers.length === 0) {
    await tools.askUser(
      "Which failure symptom should the reading prioritize first?",
      [
        "Production error or exception",
        "Deploy or build failure",
        "Performance slowdown or timeout",
        "UI state captured in evidence",
      ],
      expectedEvidenceVersion ?? undefined
    );
    return;
  }

  if (screenshotOnly && run.questionCount < 2 && answers.length === 0) {
    await tools.askUser("What part of the screenshot matters most?", [
      "The visible error message",
      "The broken UI state",
      "Console or terminal text shown in the image",
      "I am not sure yet",
    ], expectedEvidenceVersion ?? undefined);
    return;
  }

  if (expectedEvidenceVersion !== null) {
    await assertRunStillCurrent(run.caseId, expectedEvidenceVersion);
  }

  const heuristicDiagnosis = buildDiagnosisFromMemory({
    caseMemory,
    answers,
  });

  const generatedDiagnosis = await generateDiagnosisSnapshot({
    prompt,
    caseMemory: caseMemory as Record<string, unknown>,
    answers,
    heuristicDiagnosis,
  });

  await prisma.targAnalysisRun.update({
    where: {
      id: runId,
    },
    data: {
      caseMemory: {
        ...(caseMemory as Record<string, unknown>),
        investigatorPrompt: prompt,
        analysisProvider: generatedDiagnosis.provider,
        analysisModel: generatedDiagnosis.model,
        analysisProviderNote: generatedDiagnosis.note,
      } as Prisma.InputJsonValue,
    },
  });

  const verifierResult = runVerifier({
    diagnosis: generatedDiagnosis.diagnosis,
    caseMemory,
    severity: caseMemory.severity ?? null,
  });

  await recordTraceVerifierResult(runId, {
    shouldRun: verifierResult.shouldRun,
    decision: verifierResult.decision,
    notes: verifierResult.notes,
    confidence: verifierResult.diagnosis.confidence,
    nextActionMode: verifierResult.diagnosis.next_action_mode,
  });

  const savedDiagnosis = await tools.saveDiagnosisSnapshot(
    verifierResult.diagnosis,
    expectedEvidenceVersion ?? undefined
  );

  try {
    const planning = await persistPlanningAfterDiagnosis({
      caseId: run.caseId,
      diagnosis: savedDiagnosis,
      caseMemory: caseMemory as unknown as CompactCaseMemoryForVerifier,
    });
    await recordTracePlanningResult(runId, {
      breakdownId: planning.breakdownId,
      workBundleId: planning.workBundleId,
      bundleVerifier: planning.bundleVerifier,
    });
  } catch (error) {
    await recordTracePlanningResult(runId, {
      breakdownId: null,
      workBundleId: null,
      bundleVerifier: {
        ok: false,
        decision: "failed",
        notes: [
          error instanceof Error ? error.message : "Planning pipeline failed.",
        ],
      },
    });
  }

  let draft: ActionDraftViewModel | null = null;
  let draftTraceHandled = false;

  try {
    draft = await createDraftForDiagnosis({
      caseId: run.caseId,
      diagnosis: savedDiagnosis,
      caseMemory,
    });
  } catch (error) {
    draftTraceHandled = true;
    await recordTraceDraftGeneration(runId, {
      status: "failed",
      draftId: null,
      draftType: null,
      reason: error instanceof Error ? error.message : "Draft generation failed.",
    });
  }

  if (!draftTraceHandled) {
    await recordTraceDraftGeneration(runId, draft
      ? {
          status: "generated",
          draftId: draft.id,
          draftType: draft.type,
          reason: null,
        }
      : {
          status: "not_generated",
          draftId: null,
          draftType: null,
          reason:
            savedDiagnosis.confidence === "unclear"
              ? "No implementation-style draft is allowed for unclear diagnoses."
              : "Draft policy did not produce an action draft.",
        });
  }

  await finalizeRunTrace(runId, {
    finalConfidence: savedDiagnosis.confidence,
    nextActionMode: savedDiagnosis.nextActionMode,
  });
}

export async function startAnalysisRunForCase(
  userId: string,
  caseId: string,
  runTrigger = "user_manual_analyze"
) {
  const currentCase = await assertCaseAccess(userId, caseId);

  if (!currentCase) {
    throw new Error("Case not found.");
  }

  const started = await prisma.$transaction(async (tx) => {
    const claimedCase = await tx.targCase.updateMany({
      where: {
        id: caseId,
        analysisState: {
          notIn: ["ANALYZING", "NEEDS_INPUT"],
        },
      },
      data: {
        analysisState: "ANALYZING",
      },
    });

    if (claimedCase.count === 0) {
      const existing = await tx.targAnalysisRun.findFirst({
        where: {
          caseId,
          status: {
            in: ["ANALYZING", "NEEDS_INPUT"],
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return { created: null, existing };
    }

    const created = await tx.targAnalysisRun.create({
      data: {
        caseId,
        createdByUserId: userId,
        status: prismaAnalysisRunStatusMap.analyzing as never,
      },
    });

    return { created, existing: null };
  });

  if (started.existing) {
    return {
      run: serializeRun(started.existing),
      startedNew: false,
    };
  }

  const run = started.created;

  if (!run) {
    throw new Error("Could not start analysis.");
  }

  await initializeRunTrace({
    runId: run.id,
    caseId,
    runTrigger,
    evidenceInventory: (currentCase.evidence ?? []).map((item) => ({
      id: item.id,
      name: item.originalName,
      kind: item.kind,
      ingestStatus: item.ingestStatus,
      summary: extractedSummary(item.extracted),
    })),
  });

  return {
    run: serializeRun(run),
    startedNew: true,
  };
}

export async function processAnalysisRun(runId: string) {
  try {
    await runInvestigatorForRun(runId);
  } catch (error) {
    const run = await prisma.targAnalysisRun.findUnique({
      where: {
        id: runId,
      },
      select: {
        caseId: true,
      },
    });

    if (run) {
      const isStaleRun =
        error instanceof StaleAnalysisRunError ||
        (error instanceof Error &&
          error.message ===
            "Evidence changed during analysis. Results were discarded; run analysis again.");
      await recordTraceFailure(runId, {
        stage: isStaleRun ? "analysis_stale" : "analysis_run",
        message: error instanceof Error ? error.message : "Analysis failed.",
        stack: error instanceof Error ? error.stack : undefined,
        diagnostics: {
          caseId: run.caseId,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
      });

      await prisma.$transaction(async (tx) => {
        await tx.targAnalysisRun.update({
          where: {
            id: runId,
          },
          data: {
            status: prismaAnalysisRunStatusMap.failed as never,
            failureMessage:
              error instanceof Error ? error.message : "Analysis failed.",
            completedAt: new Date(),
          },
        });

        const currentCase = await tx.targCase.findUnique({
          where: {
            id: run.caseId,
          },
          select: {
            latestDiagnosisId: true,
          },
        });

        await tx.targCase.update({
          where: {
            id: run.caseId,
          },
          data: {
            analysisState: isStaleRun
              ? currentCase?.latestDiagnosisId
                ? "READY"
                : "NOT_STARTED"
              : "FAILED",
          },
        });
      });
    }
  }
}

export async function getAnalysisRunForUser(userId: string, runId: string) {
  const run = await prisma.targAnalysisRun.findFirst({
    where: {
      id: runId,
      case: {
        workspace: {
          memberships: {
            some: {
              userId,
            },
          },
        },
      },
    },
  });

  return run ? serializeRun(run) : null;
}

export async function answerAnalysisRunQuestion(
  userId: string,
  runId: string,
  input: RunAnswerInput
) {
  const run = await prisma.targAnalysisRun.findFirst({
    where: {
      id: runId,
      case: {
        workspace: {
          memberships: {
            some: {
              userId,
            },
          },
        },
      },
    },
  });

  if (!run) {
    throw new Error("Run not found.");
  }

  if (run.status !== "NEEDS_INPUT" || !run.pendingQuestion) {
    throw new Error("This run is not waiting for clarification.");
  }

  const pendingOptions = jsonArrayToStrings(run.pendingOptions);

  if (pendingOptions.length > 0 && !pendingOptions.includes(input.answer)) {
    throw new Error("Answer must match one of the available options.");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const answers = parseAnswers(run.answers);
    const nextAnswers = [
      ...answers,
      {
        question: run.pendingQuestion ?? "",
        options: pendingOptions,
        answer: input.answer,
        answeredAt: new Date().toISOString(),
      },
    ];

    const saved = await tx.targAnalysisRun.update({
      where: {
        id: runId,
      },
      data: {
        status: prismaAnalysisRunStatusMap.analyzing as never,
        pendingQuestion: null,
        pendingOptions: Prisma.JsonNull,
        answers: nextAnswers as Prisma.InputJsonValue,
      },
    });

    await tx.targCase.update({
      where: {
        id: run.caseId,
      },
      data: {
        analysisState: "ANALYZING",
      },
    });

    return saved;
  });

  await recordTraceQuestionAnswered(runId, input.answer);

  return serializeRun(updated);
}

export async function getLatestAnalysisRunForCase(userId: string, caseId: string) {
  const run = await prisma.targAnalysisRun.findFirst({
    where: {
      caseId,
      case: {
        workspace: {
          memberships: {
            some: {
              userId,
            },
          },
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return run ? serializeRun(run) : null;
}

export async function getLatestDiagnosisForCase(userId: string, caseId: string) {
  const diagnosis = await prisma.targDiagnosisSnapshot.findFirst({
    where: {
      caseId,
      case: {
        workspace: {
          memberships: {
            some: {
              userId,
            },
          },
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      claimReferenceRows: {
        include: {
          evidence: {
            select: {
              originalName: true,
              source: true,
            },
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  return diagnosis ? serializeDiagnosisSnapshot(diagnosis) : null;
}

export async function getDiagnosisForUser(userId: string, diagnosisId: string) {
  const diagnosis = await prisma.targDiagnosisSnapshot.findFirst({
    where: {
      id: diagnosisId,
      case: {
        workspace: {
          memberships: {
            some: {
              userId,
            },
          },
        },
      },
    },
    include: {
      claimReferenceRows: {
        include: {
          evidence: {
            select: {
              originalName: true,
              source: true,
            },
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  return diagnosis ? serializeDiagnosisSnapshot(diagnosis) : null;
}

export async function listDiagnosisSnapshotsForCase(
  userId: string,
  caseId: string
) {
  const snapshots = await prisma.targDiagnosisSnapshot.findMany({
    where: {
      caseId,
      case: {
        workspace: {
          memberships: {
            some: {
              userId,
            },
          },
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      claimReferenceRows: {
        include: {
          evidence: {
            select: {
              originalName: true,
              source: true,
            },
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
    take: 8,
  });

  return snapshots.map(serializeDiagnosisSnapshot);
}
