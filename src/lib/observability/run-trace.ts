import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type TraceToolCall = {
  name: string;
  input: Record<string, unknown>;
  status: "started" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  outputSummary?: string;
  errorMessage?: string;
};

type TraceQuestion = {
  question: string;
  options: string[];
  askedAt: string;
  answer?: string;
  answeredAt?: string;
};

type TraceFailure = {
  stage: string;
  message: string;
  stack?: string;
  happenedAt: string;
};

export type RunTraceRecord = {
  runId: string;
  caseId: string;
  runTrigger: string;
  status: "started" | "needs_input" | "ready" | "failed";
  startedAt: string;
  updatedAt: string;
  evidenceInventory: Array<{
    id: string;
    name: string;
    kind: string;
    ingestStatus: string;
    summary: string | null;
  }>;
  toolCallSequence: TraceToolCall[];
  clarifyingQuestions: TraceQuestion[];
  diagnosisPayload: Record<string, unknown> | null;
  verifierResult: Record<string, unknown> | null;
  finalConfidence: string | null;
  nextActionMode: string | null;
  draftGeneration: {
    status: "not_attempted" | "generated" | "not_generated" | "failed";
    draftId: string | null;
    draftType: string | null;
    reason: string | null;
  };
  /** Classification → breakdown → work bundle + deterministic bundle verifier. */
  planning: {
    breakdownId: string | null;
    workBundleId: string | null;
    bundleVerifier: {
      ok: boolean;
      decision: string;
      notes: string[];
    } | null;
  } | null;
  graderResult: Record<string, unknown> | null;
  failures: TraceFailure[];
  diagnostics: Record<string, unknown>[];
};

const TRACE_ROOT = path.join(process.cwd(), "storage", "run-traces");

async function ensureTraceRoot() {
  await mkdir(TRACE_ROOT, { recursive: true });
}

function tracePath(runId: string) {
  return path.join(TRACE_ROOT, `${runId}.json`);
}

async function readTrace(runId: string) {
  const contents = await readFile(tracePath(runId), "utf8");
  const parsed = JSON.parse(contents) as RunTraceRecord;
  if (parsed.planning === undefined) {
    parsed.planning = null;
  }
  return parsed;
}

async function writeTrace(trace: RunTraceRecord) {
  await ensureTraceRoot();
  trace.updatedAt = new Date().toISOString();
  await writeFile(tracePath(trace.runId), JSON.stringify(trace, null, 2));
}

export async function initializeRunTrace(params: {
  runId: string;
  caseId: string;
  runTrigger: string;
  evidenceInventory: RunTraceRecord["evidenceInventory"];
}) {
  const now = new Date().toISOString();
  const trace: RunTraceRecord = {
    runId: params.runId,
    caseId: params.caseId,
    runTrigger: params.runTrigger,
    status: "started",
    startedAt: now,
    updatedAt: now,
    evidenceInventory: params.evidenceInventory,
    toolCallSequence: [],
    clarifyingQuestions: [],
    diagnosisPayload: null,
    verifierResult: null,
    finalConfidence: null,
    nextActionMode: null,
    draftGeneration: {
      status: "not_attempted",
      draftId: null,
      draftType: null,
      reason: null,
    },
    planning: null,
    graderResult: null,
    failures: [],
    diagnostics: [],
  };

  await writeTrace(trace);
}

export async function updateRunTrace(
  runId: string,
  updater: (trace: RunTraceRecord) => RunTraceRecord
) {
  const current = await readTrace(runId);
  const next = updater(current);
  await writeTrace(next);
}

export async function appendTraceToolCall(
  runId: string,
  toolCall: TraceToolCall
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    toolCallSequence: [...trace.toolCallSequence, toolCall],
  }));
}

export async function markTraceNeedsInput(runId: string) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    status: "needs_input",
  }));
}

export async function recordTraceQuestionAsked(
  runId: string,
  question: string,
  options: string[]
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    status: "needs_input",
    clarifyingQuestions: [
      ...trace.clarifyingQuestions,
      {
        question,
        options,
        askedAt: new Date().toISOString(),
      },
    ],
  }));
}

export async function recordTraceQuestionAnswered(
  runId: string,
  answer: string
) {
  await updateRunTrace(runId, (trace) => {
    const questions = [...trace.clarifyingQuestions];
    const lastIndex = questions.length - 1;

    if (lastIndex >= 0) {
      questions[lastIndex] = {
        ...questions[lastIndex],
        answer,
        answeredAt: new Date().toISOString(),
      };
    }

    return {
      ...trace,
      status: "started",
      clarifyingQuestions: questions,
    };
  });
}

export async function recordTraceDiagnosisPayload(
  runId: string,
  diagnosisPayload: Record<string, unknown>
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    diagnosisPayload,
  }));
}

export async function recordTraceVerifierResult(
  runId: string,
  verifierResult: Record<string, unknown>
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    verifierResult,
  }));
}

export async function recordTraceDraftGeneration(
  runId: string,
  draftGeneration: RunTraceRecord["draftGeneration"]
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    draftGeneration,
  }));
}

export async function recordTracePlanningResult(
  runId: string,
  planning: NonNullable<RunTraceRecord["planning"]>
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    planning,
  }));
}

export async function finalizeRunTrace(
  runId: string,
  params: {
    finalConfidence: string;
    nextActionMode: string;
  }
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    status: "ready",
    finalConfidence: params.finalConfidence,
    nextActionMode: params.nextActionMode,
  }));
}

export async function recordTraceFailure(
  runId: string,
  params: {
    stage: string;
    message: string;
    stack?: string;
    diagnostics?: Record<string, unknown>;
  }
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    status: "failed",
    failures: [
      ...trace.failures,
      {
        stage: params.stage,
        message: params.message,
        stack: params.stack,
        happenedAt: new Date().toISOString(),
      },
    ],
    diagnostics: params.diagnostics
      ? [...trace.diagnostics, params.diagnostics]
      : trace.diagnostics,
  }));
}

export async function recordTraceGraderResult(
  runId: string,
  graderResult: Record<string, unknown>
) {
  await updateRunTrace(runId, (trace) => ({
    ...trace,
    graderResult,
  }));
}

export async function readRunTrace(runId: string) {
  return readTrace(runId);
}
