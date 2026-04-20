import { Prisma } from "@prisma/client";

import {
  fromPrismaActionDraftStatus,
  fromPrismaActionDraftType,
  prismaActionDraftStatusMap,
  prismaActionDraftTypeMap,
} from "@/lib/analysis/constants";
import { buildDraftWriterPrompt } from "@/lib/analysis/draft-prompt";
import {
  buildDraftFromDiagnosis,
  type CompactCaseMemoryForVerifier,
} from "@/lib/analysis/draft-writer";
import type {
  ActionDraftViewModel,
  DiagnosisSnapshotViewModel,
} from "@/lib/analysis/view-model";
import { prisma } from "@/lib/prisma";
import { getLatestDiagnosisForCase } from "@/lib/services/analysis-service";
import { assertCaseAccess } from "@/lib/services/evidence-service";
import {
  actionDraftPayloadSchema,
  type UpdateDraftInput,
} from "@/lib/validators";

function stringArray(value: Prisma.JsonValue | null) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function serializeDraft(record: {
  id: string;
  caseId: string;
  diagnosisSnapshotId: string;
  type: string;
  title: string;
  summary: string;
  whyNow: string;
  urgency: string;
  suggestedSteps: Prisma.JsonValue;
  risksOrUnknowns: Prisma.JsonValue | null;
  linkedEvidenceIds: Prisma.JsonValue;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  savedAt: Date | null;
}): ActionDraftViewModel {
  return {
    id: record.id,
    caseId: record.caseId,
    diagnosisSnapshotId: record.diagnosisSnapshotId,
    type: fromPrismaActionDraftType(record.type),
    title: record.title,
    summary: record.summary,
    whyNow: record.whyNow,
    urgency: record.urgency,
    suggestedSteps: stringArray(record.suggestedSteps),
    risksOrUnknowns: stringArray(record.risksOrUnknowns),
    linkedEvidenceIds: stringArray(record.linkedEvidenceIds),
    status: fromPrismaActionDraftStatus(record.status),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    savedAt: record.savedAt,
  };
}

export async function getLatestDraftForCase(userId: string, caseId: string) {
  const currentCase = await assertCaseAccess(userId, caseId);

  if (!currentCase) {
    throw new Error("Case not found.");
  }

  const draft = currentCase.latestDraftId
    ? await prisma.targActionDraft.findFirst({
        where: {
          id: currentCase.latestDraftId,
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
      })
    : null;

  const latestDiagnosis = await getLatestDiagnosisForCase(userId, caseId);

  return {
    draft: draft ? serializeDraft(draft) : null,
    reason:
      !draft && latestDiagnosis?.confidence === "unclear"
        ? "Unclear confidence: no implementation-style draft by policy. Use the work bundle as the primary plan."
        : !draft
          ? "No draft for this diagnosis. The work bundle is the canonical task guide; regenerate draft if you still want a narrative handoff."
          : null,
  };
}

export async function getDraftForUser(userId: string, draftId: string) {
  const draft = await prisma.targActionDraft.findFirst({
    where: {
      id: draftId,
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

  return draft ? serializeDraft(draft) : null;
}

export async function createDraftForDiagnosis(params: {
  caseId: string;
  diagnosis: DiagnosisSnapshotViewModel;
  caseMemory: CompactCaseMemoryForVerifier;
}) {
  const draftPayload = buildDraftFromDiagnosis({
    diagnosis: params.diagnosis,
    caseMemory: params.caseMemory,
  });

  if (!draftPayload) {
    await prisma.targCase.update({
      where: {
        id: params.caseId,
      },
      data: {
        latestDraftId: null,
        draftState: "NOT_STARTED",
      },
    });

    return null;
  }

  const parsedDraftPayload = actionDraftPayloadSchema.safeParse(draftPayload);

  if (!parsedDraftPayload.success) {
    throw new Error(
      parsedDraftPayload.error.issues[0]?.message ??
        "Draft payload failed validation."
    );
  }

  const prompt = buildDraftWriterPrompt({
    diagnosis: params.diagnosis,
    evidenceSummaries: params.caseMemory.evidence
      .map((item) => item.summary)
      .filter((item): item is string => typeof item === "string"),
  });
  void prompt;

  const created = await prisma.$transaction(async (tx) => {
    const draft = await tx.targActionDraft.create({
      data: {
        caseId: params.caseId,
        diagnosisSnapshotId: params.diagnosis.id,
        type: prismaActionDraftTypeMap[draftPayload.type] as never,
        title: parsedDraftPayload.data.title,
        summary: parsedDraftPayload.data.summary,
        whyNow: parsedDraftPayload.data.whyNow,
        urgency: parsedDraftPayload.data.urgency,
        suggestedSteps: parsedDraftPayload.data.suggestedSteps as Prisma.InputJsonValue,
        risksOrUnknowns: parsedDraftPayload.data.risksOrUnknowns as Prisma.InputJsonValue,
        linkedEvidenceIds: parsedDraftPayload.data.linkedEvidenceIds as Prisma.InputJsonValue,
        status: prismaActionDraftStatusMap.drafted as never,
      },
    });

    await tx.targCase.updateMany({
      where: {
        id: params.caseId,
        evidenceVersion: params.diagnosis.caseEvidenceVersion,
      },
      data: {
        latestDraftId: draft.id,
        draftState: "READY",
      },
    });

    return draft;
  });

  return serializeDraft(created);
}

export async function regenerateDraftForCase(userId: string, caseId: string) {
  const currentCase = await assertCaseAccess(userId, caseId);

  if (!currentCase) {
    throw new Error("Case not found.");
  }

  const latestDiagnosis = await getLatestDiagnosisForCase(userId, caseId);

  if (!latestDiagnosis) {
    throw new Error("No diagnosis is available for draft generation.");
  }

  const latestRun = await prisma.targAnalysisRun.findFirst({
    where: {
      caseId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      caseMemory: true,
    },
  });

  const caseMemory =
    latestRun?.caseMemory &&
    typeof latestRun.caseMemory === "object" &&
    !Array.isArray(latestRun.caseMemory)
      ? (latestRun.caseMemory as unknown as CompactCaseMemoryForVerifier)
      : null;

  if (!caseMemory) {
    throw new Error("Case memory is not available for draft generation.");
  }

  return createDraftForDiagnosis({
    caseId,
    diagnosis: latestDiagnosis,
    caseMemory,
  });
}

export async function updateDraftForUser(
  userId: string,
  draftId: string,
  input: UpdateDraftInput
) {
  const current = await prisma.targActionDraft.findFirst({
    where: {
      id: draftId,
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

  if (!current) {
    throw new Error("Draft not found.");
  }

  const updated = await prisma.targActionDraft.update({
    where: {
      id: draftId,
    },
    data: {
      status: input.status
        ? (prismaActionDraftStatusMap[input.status] as never)
        : undefined,
    },
  });

  return serializeDraft(updated);
}

export async function saveDraftForUser(userId: string, draftId: string) {
  const current = await prisma.targActionDraft.findFirst({
    where: {
      id: draftId,
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

  if (!current) {
    throw new Error("Draft not found.");
  }

  const updated = await prisma.targActionDraft.update({
    where: {
      id: draftId,
    },
    data: {
      status: prismaActionDraftStatusMap.saved as never,
      savedAt: new Date(),
    },
  });

  return serializeDraft(updated);
}
