import type { Prisma } from "@prisma/client";

import {
  fromPrismaEvidenceIngestStatus,
  fromPrismaEvidenceKind,
  fromPrismaEvidenceSource,
  prismaEvidenceIngestStatusMap,
  prismaEvidenceKindMap,
  prismaEvidenceSourceMap,
  type EvidenceKindValue,
} from "@/lib/evidence/constants";
import {
  normalizeScreenshotEvidence,
  normalizeTextEvidence,
  normalizeUnsupportedEvidence,
} from "@/lib/evidence/parser";
import {
  readStorageObject,
  reserveStorageObject,
  writeStorageObject,
} from "@/lib/evidence/storage";
import { inferEvidenceKindFromUpload, isTextLikeUpload } from "@/lib/evidence/uploads";
import { prisma } from "@/lib/prisma";
import type {
  CreateTextEvidenceInput,
  PresignUploadInput,
} from "@/lib/validators";

function isAccessibleCaseWhere(userId: string, caseId: string) {
  return {
    id: caseId,
    workspace: {
      memberships: {
        some: {
          userId,
        },
      },
    },
  };
}

async function reserveCaseEvidenceVersion(
  tx: Prisma.TransactionClient,
  caseId: string,
  userId: string
) {
  const currentCase = await tx.targCase.findFirst({
    where: isAccessibleCaseWhere(userId, caseId),
    select: {
      id: true,
      evidenceVersion: true,
    },
  });

  if (!currentCase) {
    throw new Error("Case not found.");
  }

  const nextVersion = currentCase.evidenceVersion + 1;

  await tx.targCase.update({
    where: {
      id: caseId,
    },
    data: {
      evidenceVersion: nextVersion,
    },
  });

  return nextVersion;
}

function serializeEvidenceRecord(record: {
  id: string;
  caseId: string;
  kind: string;
  source: string;
  ingestStatus: string;
  originalName: string;
  mimeType: string | null;
  rawStorageUrl: string | null;
  rawText: string | null;
  redactedText: string | null;
  extracted: Prisma.JsonValue;
  caseEvidenceVersion: number;
  createdAt: Date;
}) {
  const extracted = (record.extracted as Record<string, unknown> | null) ?? null;

  return {
    id: record.id,
    caseId: record.caseId,
    kind: fromPrismaEvidenceKind(record.kind),
    source: fromPrismaEvidenceSource(record.source),
    ingestStatus: fromPrismaEvidenceIngestStatus(record.ingestStatus),
    originalName: record.originalName,
    mimeType: record.mimeType,
    rawStorageUrl: record.rawStorageUrl,
    rawText: record.rawText,
    redactedText: record.redactedText,
    extracted,
    caseEvidenceVersion: record.caseEvidenceVersion,
    createdAt: record.createdAt,
    summary:
      extracted && typeof extracted.summary === "string"
        ? extracted.summary
        : null,
    parseWarnings:
      extracted && Array.isArray(extracted.parseWarnings)
        ? extracted.parseWarnings.filter((value): value is string => typeof value === "string")
        : [],
    notices:
      extracted && Array.isArray(extracted.notices)
        ? extracted.notices.filter((value): value is string => typeof value === "string")
        : [],
    secretsDetected:
      extracted && typeof extracted.secretsDetected === "boolean"
        ? extracted.secretsDetected
        : false,
  };
}

function isScreenshotContextOriginalName(originalName: string) {
  return /screenshot context/i.test(originalName);
}

function isScreenshotContextRecord(record: {
  kind: string;
  source: string;
  originalName: string;
  rawText?: string | null;
}) {
  const kind = fromPrismaEvidenceKind(record.kind);
  const source = fromPrismaEvidenceSource(record.source);

  if (kind !== "note" || source !== "manual_note") {
    return false;
  }

  if (isScreenshotContextOriginalName(record.originalName)) {
    return true;
  }

  return /\bscreenshot\b/i.test(record.rawText ?? "");
}

export async function assertCaseAccess(userId: string, caseId: string) {
  const currentCase = await prisma.targCase.findFirst({
    where: isAccessibleCaseWhere(userId, caseId),
    select: {
      id: true,
      title: true,
      userProblemStatement: true,
      evidenceVersion: true,
      latestDraftId: true,
      createdAt: true,
      updatedAt: true,
      workflowState: true,
      analysisState: true,
      draftState: true,
      workspaceId: true,
      evidence: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          originalName: true,
          kind: true,
          ingestStatus: true,
          extracted: true,
        },
      },
    },
  });

  return currentCase;
}

export async function reserveUploadForCase(
  userId: string,
  input: PresignUploadInput
) {
  const currentCase = await assertCaseAccess(userId, input.caseId);

  if (!currentCase) {
    throw new Error("Case not found.");
  }

  const reserved = reserveStorageObject(input.originalName);

  return {
    ...reserved,
    uploadUrl: `/api/cases/${input.caseId}/evidence/file`,
    caseId: currentCase.id,
  };
}

export async function createTextEvidenceForCase(
  userId: string,
  caseId: string,
  input: CreateTextEvidenceInput
) {
  return prisma.$transaction(async (tx) => {
    const nextVersion = await reserveCaseEvidenceVersion(tx, caseId, userId);

    return tx.targEvidence.create({
      data: {
        caseId,
        kind: prismaEvidenceKindMap[input.kind] as never,
        source: prismaEvidenceSourceMap[input.source] as never,
        ingestStatus: prismaEvidenceIngestStatusMap.parsing as never,
        originalName: input.originalName,
        mimeType: "text/plain",
        rawText: input.rawText,
        caseEvidenceVersion: nextVersion,
      },
    });
  });
}

export async function createFileEvidenceForCase(
  userId: string,
  caseId: string,
  params: {
    originalName: string;
    mimeType?: string | null;
    storageKey: string;
    rawStorageUrl: string;
    buffer: Buffer;
  }
) {
  const inferredKind = inferEvidenceKindFromUpload(
    params.originalName,
    params.mimeType
  );

  await writeStorageObject(params.storageKey, params.buffer);

  return prisma.$transaction(async (tx) => {
    const nextVersion = await reserveCaseEvidenceVersion(tx, caseId, userId);

    return tx.targEvidence.create({
      data: {
        caseId,
        kind: prismaEvidenceKindMap[inferredKind ?? "note"] as never,
        source: prismaEvidenceSourceMap.upload as never,
        ingestStatus: prismaEvidenceIngestStatusMap.parsing as never,
        originalName: params.originalName,
        mimeType: params.mimeType ?? null,
        rawStorageUrl: params.rawStorageUrl,
        caseEvidenceVersion: nextVersion,
      },
    });
  });
}

export async function listEvidenceForCase(userId: string, caseId: string) {
  const currentCase = await assertCaseAccess(userId, caseId);

  if (!currentCase) {
    throw new Error("Case not found.");
  }

  const records = await prisma.targEvidence.findMany({
    where: {
      caseId,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return records.map(serializeEvidenceRecord);
}

export async function getEvidenceForUser(userId: string, evidenceId: string) {
  const record = await prisma.targEvidence.findFirst({
    where: {
      id: evidenceId,
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

  return record ? serializeEvidenceRecord(record) : null;
}

function buildNormalizedTextFromUpload(
  kind: EvidenceKindValue,
  buffer: Buffer,
  options?: {
    originalName?: string | null;
  }
) {
  const decoded = buffer.toString("utf8");

  return normalizeTextEvidence(kind, decoded, options);
}

async function loadScreenshotContextNotes(caseId: string) {
  const records = await prisma.targEvidence.findMany({
    where: {
      caseId,
      kind: prismaEvidenceKindMap.note as never,
      source: prismaEvidenceSourceMap.manual_note as never,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      originalName: true,
      redactedText: true,
      rawText: true,
    },
  });

  return records
    .filter((record) =>
      isScreenshotContextOriginalName(record.originalName) ||
      /\bscreenshot\b/i.test(record.redactedText ?? record.rawText ?? "")
    )
    .map((record) => (record.redactedText ?? record.rawText ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

async function persistNormalizedEvidence(
  evidenceId: string,
  currentEvidence: {
    source: string;
    rawText: string | null;
  },
  normalized: Awaited<ReturnType<typeof normalizeTextEvidence>>
) {
  await prisma.targEvidence.update({
    where: {
      id: evidenceId,
    },
    data: {
      ingestStatus: prismaEvidenceIngestStatusMap[normalized.ingestStatus] as never,
      rawText:
        currentEvidence.source === "UPLOAD" && normalized.rawText !== null
          ? normalized.rawText
          : currentEvidence.rawText,
      redactedText: normalized.redactedText,
      extracted: normalized.extracted as Prisma.InputJsonValue,
    },
  });
}

export async function refreshScreenshotEvidenceForCase(
  caseId: string,
  triggerEvidenceId?: string
) {
  const shouldRefresh = triggerEvidenceId
    ? await prisma.targEvidence.findUnique({
        where: {
          id: triggerEvidenceId,
        },
        select: {
          kind: true,
          source: true,
          originalName: true,
          rawText: true,
        },
      })
    : null;

  if (
    shouldRefresh &&
    fromPrismaEvidenceKind(shouldRefresh.kind) !== "screenshot" &&
    !isScreenshotContextRecord(shouldRefresh)
  ) {
    return;
  }

  const contextNotes = await loadScreenshotContextNotes(caseId);
  const screenshots = await prisma.targEvidence.findMany({
    where: {
      caseId,
      kind: prismaEvidenceKindMap.screenshot as never,
    },
    select: {
      id: true,
      originalName: true,
      rawText: true,
      source: true,
    },
  });

  for (const screenshot of screenshots) {
    const normalized = normalizeScreenshotEvidence(screenshot.originalName, {
      contextNotes,
    });

    await persistNormalizedEvidence(screenshot.id, screenshot, normalized);
  }
}

export async function ingestEvidence(evidenceId: string) {
  const evidence = await prisma.targEvidence.findUnique({
    where: {
      id: evidenceId,
    },
  });

  if (!evidence) {
    return null;
  }

  try {
    const kind = fromPrismaEvidenceKind(evidence.kind);
    const source = fromPrismaEvidenceSource(evidence.source);
    const inferredUploadKind =
      source === "upload"
        ? inferEvidenceKindFromUpload(evidence.originalName, evidence.mimeType)
        : kind;
    const screenshotContextNotes =
      inferredUploadKind === "screenshot"
        ? await loadScreenshotContextNotes(evidence.caseId)
        : [];

    const normalized =
      source !== "upload"
        ? normalizeTextEvidence(kind, evidence.rawText ?? "", {
            originalName: evidence.originalName,
            source,
          })
        : inferredUploadKind === "screenshot"
          ? normalizeScreenshotEvidence(evidence.originalName, {
              contextNotes: screenshotContextNotes,
            })
          : isTextLikeUpload(inferredUploadKind)
            ? buildNormalizedTextFromUpload(
                inferredUploadKind,
                await readStorageObject(
                  (evidence.rawStorageUrl ?? "").replace("local://evidence/", "")
                ),
                {
                  originalName: evidence.originalName,
                }
              )
            : normalizeUnsupportedEvidence(evidence.originalName);

    await persistNormalizedEvidence(evidenceId, evidence, normalized);

    return normalized;
  } catch (error) {
    await prisma.targEvidence.update({
      where: {
        id: evidenceId,
      },
      data: {
        ingestStatus: prismaEvidenceIngestStatusMap.failed as never,
        extracted: {
          timestamps: [],
          requestIds: [],
          services: [],
          endpoints: [],
          stackFrames: [],
          envHints: [],
          versionHints: [],
          secretsDetected: false,
          parseWarnings: [
            error instanceof Error ? error.message : "Evidence ingestion failed.",
          ],
          notices: [],
          summary: "Evidence ingestion failed.",
          screenshotText: null,
        } as Prisma.InputJsonValue,
      },
    });

    return null;
  }
}

export async function buildCaseMemory(caseId: string) {
  const [latestEvidence] = await prisma.targEvidence.findMany({
    where: {
      caseId,
    },
    orderBy: {
      caseEvidenceVersion: "desc",
    },
    take: 1,
    select: {
      caseEvidenceVersion: true,
    },
  });

  const nextVersion = latestEvidence?.caseEvidenceVersion ?? 1;

  await prisma.targCase.update({
    where: {
      id: caseId,
    },
    data: {
      evidenceVersion: nextVersion,
    },
  });
}
