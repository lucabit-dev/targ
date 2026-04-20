import { Prisma } from "@prisma/client";

import type { CompactCaseMemoryForVerifier } from "@/lib/analysis/draft-writer";
import { verifyWorkBundle } from "@/lib/analysis/bundle-verifier";
import {
  fromPrismaDiagnosisConfidence,
  prismaDiagnosisConfidenceMap,
} from "@/lib/analysis/constants";
import {
  buildWorkBundleFromBreakdown,
  classifyProblemFromDiagnosis,
  decomposeFromDiagnosis,
} from "@/lib/analysis/planning-pipeline";
import type {
  BreakdownViewModel,
  CasePlanningArtifactsViewModel,
  DiagnosisSnapshotViewModel,
  WorkBundleViewModel,
} from "@/lib/analysis/view-model";
import type {
  ArtifactDependency,
  EvidenceAnchor,
  ProblemClassification,
  RankedHypothesis,
  UnknownItem,
  WorkBundlePayload,
} from "@/lib/planning/bundle-types";
import { prisma } from "@/lib/prisma";

export type PlanningPersistResult = {
  breakdownId: string;
  workBundleId: string;
  bundleVerifier: {
    ok: boolean;
    decision: string;
    notes: string[];
  };
};

/**
 * Planning stack after a diagnosis snapshot exists (stages 3–6 in
 * `src/lib/analysis/analysis-pipeline.ts`):
 * classify → decompose → build bundle from breakdown → `verifyWorkBundle` → persist rows.
 *
 * Task groups/tasks must originate from `decomposeFromDiagnosis` + `buildWorkBundleFromBreakdown`,
 * not generic flat suggestions.
 */
export async function persistPlanningAfterDiagnosis(params: {
  caseId: string;
  diagnosis: DiagnosisSnapshotViewModel;
  caseMemory: CompactCaseMemoryForVerifier;
}): Promise<PlanningPersistResult> {
  const { caseId, diagnosis, caseMemory } = params;

  const classification = classifyProblemFromDiagnosis(diagnosis, caseMemory);
  const breakdownDoc = decomposeFromDiagnosis({
    diagnosis,
    classification,
    caseMemory,
  });

  const inheritedConfidence =
    prismaDiagnosisConfidenceMap[diagnosis.confidence] as
      | "LIKELY"
      | "PLAUSIBLE"
      | "UNCLEAR";

  return prisma.$transaction(async (tx) => {
    const breakdownRow = await tx.targBreakdown.create({
      data: {
        caseId,
        diagnosisSnapshotId: diagnosis.id,
        caseEvidenceVersion: diagnosis.caseEvidenceVersion,
        schemaVersion: 1,
        problemClassification:
          breakdownDoc.problemClassification as Prisma.InputJsonValue,
        sharedSpine: breakdownDoc.sharedSpine as Prisma.InputJsonValue,
        modeExtensions: breakdownDoc.modeExtensions as Prisma.InputJsonValue,
        rankedHypotheses: breakdownDoc.rankedHypotheses as Prisma.InputJsonValue,
        unknowns: breakdownDoc.unknowns as Prisma.InputJsonValue,
        artifactDependencies:
          breakdownDoc.artifactDependencies as Prisma.InputJsonValue,
        evidenceAnchors: breakdownDoc.evidenceAnchors as Prisma.InputJsonValue,
        inheritedConfidence,
      },
    });

    let bundlePayload = buildWorkBundleFromBreakdown({
      diagnosis,
      breakdown: breakdownDoc,
      breakdownIdPlaceholder: breakdownRow.id,
      caseMemory,
    });

    const verifierResult = verifyWorkBundle({
      payload: bundlePayload,
      diagnosis,
      breakdown: breakdownDoc,
    });
    bundlePayload = verifierResult.payload;
    bundlePayload.lineage.breakdownId = breakdownRow.id;

    const workBundleRow = await tx.targWorkBundle.create({
      data: {
        caseId,
        diagnosisSnapshotId: diagnosis.id,
        breakdownId: breakdownRow.id,
        schemaVersion: bundlePayload.schemaVersion,
        label: bundlePayload.title.slice(0, 120),
        payload: bundlePayload as unknown as Prisma.InputJsonValue,
        status: "GENERATED",
      },
    });

    await tx.targCase.updateMany({
      where: {
        id: caseId,
        evidenceVersion: diagnosis.caseEvidenceVersion,
      },
      data: {
        latestBreakdownId: breakdownRow.id,
        latestWorkBundleId: workBundleRow.id,
        breakdownState: "READY",
        workBundleState: "READY",
      },
    });

    return {
      breakdownId: breakdownRow.id,
      workBundleId: workBundleRow.id,
      bundleVerifier: {
        ok: verifierResult.ok,
        decision: verifierResult.decision,
        notes: verifierResult.notes,
      },
    };
  });
}

const workspaceMemberFilter = (userId: string) => ({
  workspace: {
    memberships: {
      some: { userId },
    },
  },
});

function asJsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseProblemClassification(
  value: Prisma.JsonValue | null
): ProblemClassification | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const primaryMode = obj.primaryMode;
  if (typeof primaryMode !== "string" || primaryMode.length === 0) {
    return null;
  }
  return obj as unknown as ProblemClassification;
}

function parseRankedHypotheses(value: Prisma.JsonValue): RankedHypothesis[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is RankedHypothesis =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as RankedHypothesis).id === "string" &&
      typeof (item as RankedHypothesis).text === "string"
  );
}

function parseUnknowns(value: Prisma.JsonValue): UnknownItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is UnknownItem =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as UnknownItem).id === "string" &&
      typeof (item as UnknownItem).text === "string"
  );
}

function parseArtifactDependencies(value: Prisma.JsonValue): ArtifactDependency[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is ArtifactDependency =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as ArtifactDependency).id === "string"
  );
}

function parseEvidenceAnchors(value: Prisma.JsonValue): EvidenceAnchor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is EvidenceAnchor =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as EvidenceAnchor).id === "string" &&
      typeof (item as EvidenceAnchor).evidenceId === "string"
  );
}

function parseWorkBundlePayload(value: Prisma.JsonValue): WorkBundlePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Work bundle payload is not a JSON object.");
  }
  return value as unknown as WorkBundlePayload;
}

export function serializeBreakdownRow(record: {
  id: string;
  caseId: string;
  diagnosisSnapshotId: string;
  caseEvidenceVersion: number;
  schemaVersion: number;
  problemClassification: Prisma.JsonValue | null;
  sharedSpine: Prisma.JsonValue;
  modeExtensions: Prisma.JsonValue;
  rankedHypotheses: Prisma.JsonValue;
  unknowns: Prisma.JsonValue;
  artifactDependencies: Prisma.JsonValue;
  evidenceAnchors: Prisma.JsonValue;
  inheritedConfidence: string | null;
  createdAt: Date;
}): BreakdownViewModel {
  return {
    id: record.id,
    caseId: record.caseId,
    diagnosisSnapshotId: record.diagnosisSnapshotId,
    caseEvidenceVersion: record.caseEvidenceVersion,
    schemaVersion: record.schemaVersion,
    problemClassification: parseProblemClassification(record.problemClassification),
    sharedSpine: asJsonObject(record.sharedSpine),
    modeExtensions: asJsonObject(record.modeExtensions),
    rankedHypotheses: parseRankedHypotheses(record.rankedHypotheses),
    unknowns: parseUnknowns(record.unknowns),
    artifactDependencies: parseArtifactDependencies(record.artifactDependencies),
    evidenceAnchors: parseEvidenceAnchors(record.evidenceAnchors),
    inheritedConfidence: record.inheritedConfidence
      ? fromPrismaDiagnosisConfidence(record.inheritedConfidence)
      : null,
    createdAt: record.createdAt,
  };
}

export function serializeWorkBundleRow(record: {
  id: string;
  caseId: string;
  diagnosisSnapshotId: string;
  breakdownId: string;
  schemaVersion: number;
  label: string | null;
  status: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
}): WorkBundleViewModel {
  return {
    id: record.id,
    caseId: record.caseId,
    diagnosisSnapshotId: record.diagnosisSnapshotId,
    breakdownId: record.breakdownId,
    schemaVersion: record.schemaVersion,
    label: record.label,
    status: record.status === "DISMISSED" ? "dismissed" : "generated",
    payload: parseWorkBundlePayload(record.payload),
    createdAt: record.createdAt,
  };
}

/**
 * Latest breakdown + work bundle for a case (via case pointers). Both null if not generated yet.
 */
export async function getPlanningArtifactsForCase(
  userId: string,
  caseId: string
): Promise<CasePlanningArtifactsViewModel | null> {
  const currentCase = await prisma.targCase.findFirst({
    where: {
      id: caseId,
      ...workspaceMemberFilter(userId),
    },
    select: {
      latestBreakdownId: true,
      latestWorkBundleId: true,
    },
  });

  if (!currentCase) {
    return null;
  }

  const [breakdownRow, workBundleRow] = await Promise.all([
    currentCase.latestBreakdownId
      ? prisma.targBreakdown.findFirst({
          where: {
            id: currentCase.latestBreakdownId,
            caseId,
            case: workspaceMemberFilter(userId),
          },
        })
      : null,
    currentCase.latestWorkBundleId
      ? prisma.targWorkBundle.findFirst({
          where: {
            id: currentCase.latestWorkBundleId,
            caseId,
            case: workspaceMemberFilter(userId),
          },
        })
      : null,
  ]);

  return {
    breakdown: breakdownRow ? serializeBreakdownRow(breakdownRow) : null,
    workBundle: workBundleRow ? serializeWorkBundleRow(workBundleRow) : null,
  };
}
