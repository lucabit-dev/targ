import { Prisma } from "@prisma/client";

import {
  fromPrismaClaimReferenceRelation,
  fromPrismaDiagnosisConfidence,
  fromPrismaDiagnosisNextActionMode,
  prismaAnalysisRunStatusMap,
  prismaDiagnosisConfidenceMap,
  prismaDiagnosisNextActionModeMap,
} from "@/lib/analysis/constants";
import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";
import { buildPersistedClaimReferenceRows } from "@/lib/analysis/claim-references";
import { buildCompactCaseMemory } from "@/lib/analysis/case-memory";
import {
  buildProblemBriefPayload,
  parseProblemBriefJson,
} from "@/lib/analysis/problem-brief";
import { fromPrismaEvidenceSource, EVIDENCE_SOURCE_LABELS } from "@/lib/evidence/constants";
import {
  appendTraceToolCall,
  recordTraceDiagnosisPayload,
  recordTraceQuestionAsked,
} from "@/lib/observability/run-trace";
import { prisma } from "@/lib/prisma";
import {
  diagnosisSnapshotPayloadSchema,
  type DiagnosisSnapshotPayload,
} from "@/lib/validators";

type ChunkSelector = {
  startLine?: number;
  endLine?: number;
};

function serializeDiagnosisSnapshot(record: {
  id: string;
  caseId: string;
  analysisRunId: string;
  caseEvidenceVersion: number;
  problemBrief: Prisma.JsonValue | null;
  status: string;
  confidence: string;
  probableRootCause: string;
  affectedArea: string;
  summary: string;
  trace: Prisma.JsonValue;
  hypotheses: Prisma.JsonValue;
  contradictions: Prisma.JsonValue;
  missingEvidence: Prisma.JsonValue;
  nextActionMode: string;
  nextActionText: string;
  claimReferences: Prisma.JsonValue;
  claimReferenceRows?: Array<{
    id: string;
    claimKey: string;
    claimText: string;
    relation: string;
    sourceLabel: string | null;
    summary: string | null;
    excerptText: string | null;
    evidenceId: string | null;
    evidence: {
      originalName: string;
      source: string;
    } | null;
  }>;
  createdAt: Date;
}): DiagnosisSnapshotViewModel {
  const traceEntries = Array.isArray(record.trace)
    ? (record.trace as Array<{ claim: string; evidence: string }>).map((entry, index) => ({
        claimKey: `trace-${index}`,
        claim: entry.claim,
        evidence: entry.evidence,
      }))
    : [];

  return {
    id: record.id,
    caseId: record.caseId,
    analysisRunId: record.analysisRunId,
    caseEvidenceVersion: record.caseEvidenceVersion,
    problemBrief: parseProblemBriefJson(record.problemBrief),
    status: record.status as "provisional" | "revised",
    confidence: fromPrismaDiagnosisConfidence(record.confidence),
    probableRootCause: record.probableRootCause,
    affectedArea: record.affectedArea,
    summary: record.summary,
    trace: traceEntries,
    hypotheses: Array.isArray(record.hypotheses)
      ? (record.hypotheses as DiagnosisSnapshotViewModel["hypotheses"])
      : [],
    contradictions: Array.isArray(record.contradictions)
      ? (record.contradictions.filter(
          (item): item is string => typeof item === "string"
        ) as string[])
      : [],
    missingEvidence: Array.isArray(record.missingEvidence)
      ? (record.missingEvidence.filter(
          (item): item is string => typeof item === "string"
        ) as string[])
      : [],
    nextActionMode: fromPrismaDiagnosisNextActionMode(record.nextActionMode),
    nextActionText: record.nextActionText,
    claimReferences: (record.claimReferenceRows ?? []).map((item) => ({
      id: item.id,
      claimKey: item.claimKey,
      claimText: item.claimText,
      relation: fromPrismaClaimReferenceRelation(item.relation),
      evidenceId: item.evidenceId,
      evidenceName: item.evidence?.originalName ?? null,
      sourceLabel:
        item.sourceLabel ??
        (item.evidence
          ? EVIDENCE_SOURCE_LABELS[fromPrismaEvidenceSource(item.evidence.source)]
          : null),
      summary: item.summary,
      excerpt: item.excerptText,
    })),
    createdAt: record.createdAt,
  };
}

export async function listEvidence(caseId: string) {
  const evidence = await prisma.targEvidence.findMany({
    where: {
      caseId,
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      originalName: true,
      kind: true,
      ingestStatus: true,
      redactedText: true,
      extracted: true,
    },
  });

  return evidence.map((item) => ({
    id: item.id,
    originalName: item.originalName,
    kind: item.kind,
    ingestStatus: item.ingestStatus,
    redactedText: item.redactedText,
    extracted: item.extracted,
  }));
}

export async function openEvidence(
  evidenceId: string,
  chunkSelector?: ChunkSelector
) {
  const evidence = await prisma.targEvidence.findUnique({
    where: {
      id: evidenceId,
    },
    select: {
      id: true,
      originalName: true,
      redactedText: true,
      rawText: true,
    },
  });

  if (!evidence) {
    throw new Error("Evidence not found.");
  }

  const text = evidence.redactedText ?? evidence.rawText ?? "";

  if (!chunkSelector || text.length === 0) {
    return {
      id: evidence.id,
      originalName: evidence.originalName,
      content: text,
    };
  }

  const lines = text.split("\n");
  const startIndex = Math.max((chunkSelector.startLine ?? 1) - 1, 0);
  const endIndex = Math.min(chunkSelector.endLine ?? lines.length, lines.length);

  return {
    id: evidence.id,
    originalName: evidence.originalName,
    content: lines.slice(startIndex, endIndex).join("\n"),
  };
}

export async function searchEvidence(caseId: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const evidence = await prisma.targEvidence.findMany({
    where: {
      caseId,
    },
    select: {
      id: true,
      originalName: true,
      redactedText: true,
      extracted: true,
    },
  });

  return evidence
    .map((item) => {
      const summary =
        item.extracted &&
        typeof item.extracted === "object" &&
        !Array.isArray(item.extracted) &&
        typeof (item.extracted as Record<string, unknown>).summary === "string"
          ? ((item.extracted as Record<string, unknown>).summary as string)
          : "";
      const haystack = [
        item.originalName,
        summary,
        item.redactedText ?? "",
      ]
        .join("\n")
        .toLowerCase();

      return {
        id: item.id,
        originalName: item.originalName,
        matched: haystack.includes(normalizedQuery),
        summary,
      };
    })
    .filter((item) => item.matched)
    .slice(0, 10);
}

export async function inspectImage(evidenceId: string) {
  const evidence = await prisma.targEvidence.findUnique({
    where: {
      id: evidenceId,
    },
    select: {
      id: true,
      originalName: true,
      extracted: true,
    },
  });

  if (!evidence) {
    throw new Error("Evidence not found.");
  }

  const extracted =
    evidence.extracted &&
    typeof evidence.extracted === "object" &&
    !Array.isArray(evidence.extracted)
      ? (evidence.extracted as Record<string, unknown>)
      : {};

  return {
    id: evidence.id,
    originalName: evidence.originalName,
    summary:
      typeof extracted.summary === "string"
        ? extracted.summary
        : "Screenshot evidence needs review.",
    screenshotText:
      typeof extracted.screenshotText === "string"
        ? extracted.screenshotText
        : null,
    parseWarnings: Array.isArray(extracted.parseWarnings)
      ? extracted.parseWarnings.filter(
          (item): item is string => typeof item === "string"
        )
      : [],
  };
}

export async function fetchCaseMemory(caseId: string) {
  return buildCompactCaseMemory(caseId);
}

export async function askUser(
  runId: string,
  question: string,
  options: string[],
  expectedEvidenceVersion?: number
) {
  await prisma.$transaction(async (tx) => {
    const run = await tx.targAnalysisRun.findUnique({
      where: {
        id: runId,
      },
      select: {
        caseId: true,
        questionCount: true,
      },
    });

    if (!run) {
      throw new Error("Run not found.");
    }

    if (typeof expectedEvidenceVersion === "number") {
      const currentCase = await tx.targCase.findUnique({
        where: {
          id: run.caseId,
        },
        select: {
          evidenceVersion: true,
        },
      });

      if (!currentCase) {
        throw new Error("Case not found.");
      }

      if (currentCase.evidenceVersion !== expectedEvidenceVersion) {
        throw new Error(
          "Evidence changed during analysis. Results were discarded; run analysis again."
        );
      }
    }

    await tx.targAnalysisRun.update({
      where: {
        id: runId,
      },
      data: {
        status: prismaAnalysisRunStatusMap.needs_input as never,
        questionCount: run.questionCount + 1,
        pendingQuestion: question,
        pendingOptions: options as Prisma.InputJsonValue,
      },
    });

    await tx.targCase.update({
      where: {
        id: run.caseId,
      },
      data: {
        analysisState: "NEEDS_INPUT",
      },
    });
  });
}

export async function saveDiagnosisSnapshot(
  runId: string,
  caseId: string,
  payload: DiagnosisSnapshotPayload,
  expectedEvidenceVersion?: number
) {
  const parsed = diagnosisSnapshotPayloadSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? "Diagnosis payload failed validation."
    );
  }

  const snapshot = await prisma.$transaction(async (tx) => {
    const evidence = await tx.targEvidence.findMany({
      where: {
        caseId,
      },
      select: {
        id: true,
        originalName: true,
        source: true,
        redactedText: true,
        rawText: true,
        extracted: true,
      },
    });

    const currentCase = await tx.targCase.findUnique({
      where: {
        id: caseId,
      },
      select: {
        evidenceVersion: true,
        title: true,
        userProblemStatement: true,
      },
    });

    if (!currentCase) {
      throw new Error("Case not found.");
    }

    if (
      typeof expectedEvidenceVersion === "number" &&
      currentCase.evidenceVersion !== expectedEvidenceVersion
    ) {
      throw new Error(
        "Evidence changed during analysis. Results were discarded; run analysis again."
      );
    }

    const problemBrief = buildProblemBriefPayload({
      userProblemStatement: currentCase.userProblemStatement,
      diagnosis: parsed.data,
    });

    const created = await tx.targDiagnosisSnapshot.create({
      data: {
        caseId,
        analysisRunId: runId,
        caseEvidenceVersion: currentCase.evidenceVersion,
        problemBrief: problemBrief as Prisma.InputJsonValue,
        status: parsed.data.status,
        confidence: prismaDiagnosisConfidenceMap[parsed.data.confidence] as never,
        probableRootCause: parsed.data.probable_root_cause,
        affectedArea: parsed.data.affected_area,
        summary: parsed.data.summary,
        trace: parsed.data.trace as Prisma.InputJsonValue,
        hypotheses: parsed.data.hypotheses as Prisma.InputJsonValue,
        contradictions: parsed.data.contradictions as Prisma.InputJsonValue,
        missingEvidence: parsed.data.missing_evidence as Prisma.InputJsonValue,
        nextActionMode:
          prismaDiagnosisNextActionModeMap[parsed.data.next_action_mode] as never,
        nextActionText: parsed.data.next_action_text,
        claimReferences: parsed.data.claim_references as Prisma.InputJsonValue,
      },
    });

    const persistedClaimReferences = buildPersistedClaimReferenceRows({
      diagnosisPayload: parsed.data,
      evidence,
    });

    if (persistedClaimReferences.length > 0) {
      await tx.targClaimReference.createMany({
        data: persistedClaimReferences.map((item) => ({
          diagnosisSnapshotId: created.id,
          claimKey: item.claimKey,
          claimText: item.claimText,
          relation: item.relation as never,
          sourceLabel: item.sourceLabel,
          summary: item.summary,
          excerptText: item.excerptText,
          evidenceId: item.evidenceId,
        })),
      });
    }

    await tx.targAnalysisRun.update({
      where: {
        id: runId,
      },
      data: {
        latestDiagnosisId: created.id,
        status: prismaAnalysisRunStatusMap.ready as never,
        pendingQuestion: null,
        pendingOptions: Prisma.JsonNull,
        completedAt: new Date(),
      },
    });

    await tx.targCase.update({
      where: {
        id: caseId,
      },
      data: {
        latestDiagnosisId: created.id,
        confidence: prismaDiagnosisConfidenceMap[parsed.data.confidence] as never,
        analysisState: "READY",
      },
    });

    return created;
  });

  const snapshotWithReferences = await prisma.targDiagnosisSnapshot.findUnique({
    where: {
      id: snapshot.id,
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

  if (!snapshotWithReferences) {
    throw new Error("Diagnosis snapshot was created but could not be reloaded.");
  }

  return serializeDiagnosisSnapshot(snapshotWithReferences);
}

export function createInvestigatorTools(params: {
  runId: string;
  caseId: string;
}) {
  async function withTrace<T>(
    name: string,
    input: Record<string, unknown>,
    callback: () => Promise<T>,
    outputSummaryBuilder?: (value: T) => string
  ) {
    const startedAt = new Date().toISOString();

    await appendTraceToolCall(params.runId, {
      name,
      input,
      status: "started",
      startedAt,
    });

    try {
      const result = await callback();

      await appendTraceToolCall(params.runId, {
        name,
        input,
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        outputSummary: outputSummaryBuilder ? outputSummaryBuilder(result) : undefined,
      });

      return result;
    } catch (error) {
      await appendTraceToolCall(params.runId, {
        name,
        input,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : "Unknown tool failure.",
      });

      throw error;
    }
  }

  return {
    listEvidence: () =>
      withTrace("listEvidence", { caseId: params.caseId }, () => listEvidence(params.caseId), (value) => `${value.length} evidence item(s)`),
    openEvidence: (evidenceId: string, chunkSelector?: ChunkSelector) =>
      withTrace(
        "openEvidence",
        { evidenceId, chunkSelector: chunkSelector ?? null },
        () => openEvidence(evidenceId, chunkSelector),
        (value) => `${value.originalName}`
      ),
    searchEvidence: (query: string) =>
      withTrace("searchEvidence", { caseId: params.caseId, query }, () => searchEvidence(params.caseId, query), (value) => `${value.length} match(es)`),
    inspectImage: (evidenceId: string) =>
      withTrace("inspectImage", { evidenceId }, () => inspectImage(evidenceId), (value) => value.originalName),
    fetchCaseMemory: () =>
      withTrace("fetchCaseMemory", { caseId: params.caseId }, () => fetchCaseMemory(params.caseId), () => "case memory loaded"),
    askUser: async (
      question: string,
      options: string[],
      expectedEvidenceVersion?: number
    ) => {
      await recordTraceQuestionAsked(params.runId, question, options);
      return withTrace(
        "askUser",
        { question, options },
        () => askUser(params.runId, question, options, expectedEvidenceVersion),
        () => "clarifying question saved"
      );
    },
    saveDiagnosisSnapshot: (
      payload: DiagnosisSnapshotPayload,
      expectedEvidenceVersion?: number
    ) =>
      withTrace(
        "saveDiagnosisSnapshot",
        {
          confidence: payload.confidence,
          nextActionMode: payload.next_action_mode,
        },
        async () => {
          await recordTraceDiagnosisPayload(params.runId, payload as Record<string, unknown>);
          return saveDiagnosisSnapshot(
            params.runId,
            params.caseId,
            payload,
            expectedEvidenceVersion
          );
        },
        (value) => value.id
      ),
  };
}

export { serializeDiagnosisSnapshot };
