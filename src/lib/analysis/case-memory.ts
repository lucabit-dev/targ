import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  fromPrismaEvidenceIngestStatus,
  fromPrismaEvidenceKind,
} from "@/lib/evidence/constants";
import {
  problemLensFromPrisma,
  solveModeFromPrisma,
} from "@/lib/planning/intake-preferences";
import { parseWorkspacePlaybook } from "@/lib/workspace/playbook";

function stringArrayFromJsonValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function objectArrayFromJsonValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null
      )
    : [];
}

function normalizeExtractedJson(extracted: Prisma.JsonValue | null) {
  const record =
    extracted && typeof extracted === "object" && !Array.isArray(extracted)
      ? (extracted as Record<string, unknown>)
      : {};

  return {
    summary: typeof record.summary === "string" ? record.summary : null,
    notices: stringArrayFromJsonValue(record.notices),
    parseWarnings: stringArrayFromJsonValue(record.parseWarnings),
    capturedFields: stringArrayFromJsonValue(record.capturedFields),
    services: stringArrayFromJsonValue(record.services),
    endpoints: stringArrayFromJsonValue(record.endpoints),
    envHints: stringArrayFromJsonValue(record.envHints),
    requestIds: stringArrayFromJsonValue(record.requestIds),
    timestamps: stringArrayFromJsonValue(record.timestamps),
    versionHints: stringArrayFromJsonValue(record.versionHints),
    focusTags: stringArrayFromJsonValue(record.focusTags),
    stackFrames: objectArrayFromJsonValue(record.stackFrames)
      .map((item) => item.raw)
      .filter((item): item is string => typeof item === "string"),
    screenshotText:
      typeof record.screenshotText === "string" ? record.screenshotText : null,
    contextSummary:
      typeof record.contextSummary === "string" ? record.contextSummary : null,
    contextLinked:
      typeof record.contextLinked === "boolean" ? record.contextLinked : false,
    secretsDetected:
      typeof record.secretsDetected === "boolean" ? record.secretsDetected : false,
  };
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export async function buildCompactCaseMemory(caseId: string) {
  const currentCase = await prisma.targCase.findUnique({
    where: {
      id: caseId,
    },
    select: {
      id: true,
      title: true,
      userProblemStatement: true,
      evidenceVersion: true,
      workflowState: true,
      analysisState: true,
      solveMode: true,
      problemLens: true,
      severity: true,
      createdAt: true,
      updatedAt: true,
      workspace: {
        select: {
          playbookConfig: true,
          playbookConfiguredAt: true,
        },
      },
    },
  });

  if (!currentCase) {
    throw new Error("Case not found.");
  }

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
      rawText: true,
      redactedText: true,
      extracted: true,
      createdAt: true,
    },
  });

  const normalizedEvidence = evidence.map((item) => {
    const extracted = normalizeExtractedJson(item.extracted);

    return {
      id: item.id,
      name: item.originalName,
      kind: fromPrismaEvidenceKind(item.kind),
      ingestStatus: fromPrismaEvidenceIngestStatus(item.ingestStatus),
      summary: extracted.summary,
      notices: extracted.notices,
      parseWarnings: extracted.parseWarnings,
      capturedFields: extracted.capturedFields,
      services: extracted.services,
      endpoints: extracted.endpoints,
      envHints: extracted.envHints,
      requestIds: extracted.requestIds,
      timestamps: extracted.timestamps,
      versionHints: extracted.versionHints,
      focusTags: extracted.focusTags,
      stackFrames: extracted.stackFrames,
      screenshotText: extracted.screenshotText,
      contextSummary: extracted.contextSummary,
      contextLinked: extracted.contextLinked,
      secretsDetected: extracted.secretsDetected,
      textPreview: (item.redactedText ?? item.rawText ?? "").slice(0, 800),
      createdAt: item.createdAt.toISOString(),
    };
  });

  const countsByStatus = normalizedEvidence.reduce<Record<string, number>>(
    (accumulator, item) => {
      accumulator[item.ingestStatus] = (accumulator[item.ingestStatus] ?? 0) + 1;
      return accumulator;
    },
    {}
  );

  const services = unique(
    normalizedEvidence.flatMap((item) => item.services).slice(0, 20)
  );
  const endpoints = unique(
    normalizedEvidence.flatMap((item) => item.endpoints).slice(0, 20)
  );
  const envHints = unique(
    normalizedEvidence.flatMap((item) => item.envHints).slice(0, 20)
  );

  return {
    caseId: currentCase.id,
    title: currentCase.title,
    userProblemStatement: currentCase.userProblemStatement,
    solveMode: solveModeFromPrisma(currentCase.solveMode),
    problemLens: problemLensFromPrisma(currentCase.problemLens),
    evidenceVersion: currentCase.evidenceVersion,
    workflowState: currentCase.workflowState,
    analysisState: currentCase.analysisState,
    severity: currentCase.severity,
    workspacePlaybook: parseWorkspacePlaybook(currentCase.workspace.playbookConfig),
    workspacePlaybookConfiguredAt: currentCase.workspace.playbookConfiguredAt?.toISOString() ?? null,
    evidenceCounts: {
      total: normalizedEvidence.length,
      ready: countsByStatus.ready ?? 0,
      needsReview: countsByStatus.needs_review ?? 0,
      unsupported: countsByStatus.unsupported ?? 0,
      failed: countsByStatus.failed ?? 0,
    },
    commonSignals: {
      services,
      endpoints,
      envHints,
    },
    evidence: normalizedEvidence,
    generatedAt: new Date().toISOString(),
  };
}
