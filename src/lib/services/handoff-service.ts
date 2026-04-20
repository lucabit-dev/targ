/**
 * Handoff service — orchestrates packet production for a case.
 *
 * Flow (Phase 1.3):
 *   1. Assert the user has access to the case.
 *   2. Resolve the diagnosis to hand off (by id, or the latest for the case).
 *   3. Load all evidence for the case.
 *   4. Call `buildHandoffPacket` with domain view models.
 *   5. Validate invariants, truncate to the target's byte budget.
 *   6. Render via the target-specific renderer.
 *   7. Persist a `TargHandoff` row and return the delivery payload.
 *
 * The service is deliberately agnostic to HTTP — the route layer passes in a
 * `requestOrigin` so the packet's `meta.caseUrl` stays absolute without
 * pulling Next's `headers()` into domain code.
 */

import { prisma } from "@/lib/prisma";
import { getEvidenceForUser, listEvidenceForCase } from "@/lib/services/evidence-service";
import {
  getDiagnosisForUser,
  getLatestDiagnosisForCase,
} from "@/lib/services/analysis-service";
import {
  assertPacketValid,
  buildHandoffPacket,
  type HandoffPacket,
  type HandoffPacketInput,
} from "@/lib/handoff/packet";
import {
  getTargetConfig,
  toPrismaHandoffTarget,
  type HandoffTargetId,
} from "@/lib/handoff/targets";
import { truncatePacketToBudget } from "@/lib/handoff/truncate";
import { loadRepoEnrichmentForCase } from "@/lib/services/handoff-enrichment-service";

// Bumped when the packet-producing logic (builder, renderers, truncation)
// changes in a way that affects how a receiver should interpret the packet.
const GENERATOR_VERSION = "targ-handoff/1.0.0";

export class HandoffError extends Error {
  public readonly code: HandoffErrorCode;
  public readonly status: number;

  constructor(code: HandoffErrorCode, message: string, status: number) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    this.status = status;
  }
}

export type HandoffErrorCode =
  | "case_not_found"
  | "diagnosis_not_found"
  | "diagnosis_missing"
  | "target_unavailable"
  | "invariant_violation"
  | "no_evidence";

export type HandoffRequest = {
  userId: string;
  caseId: string;
  target: HandoffTargetId;
  diagnosisId?: string;
  workBundleId?: string;
  /** Absolute origin of the TARG app, e.g. "https://targ.app". */
  requestOrigin: string;
};

export type HandoffResult = {
  handoffId: string;
  target: HandoffTargetId;
  kind: "copy" | "deep_link" | "dispatch";
  /** Rendered text actually stored and delivered (post-truncation). */
  packetMd: string;
  /** Deep link URL for `cursor`; undefined for other targets. */
  url?: string;
  /** External reference returned by a dispatcher (issue URL, etc). */
  externalRef?: string;
  /** Truncation steps that ran, for debugging. */
  truncationSteps: string[];
  usedMinimalPacket: boolean;
};

async function loadCaseForHandoff(userId: string, caseId: string) {
  return prisma.targCase.findFirst({
    where: {
      id: caseId,
      workspace: {
        memberships: {
          some: { userId },
        },
      },
    },
    select: {
      id: true,
      title: true,
      userProblemStatement: true,
      severity: true,
      problemLens: true,
      solveMode: true,
      latestDiagnosisId: true,
    },
  });
}

function lowercaseEnum(value: string | null): string | null {
  return value ? value.toLowerCase() : null;
}

function buildCaseUrl(origin: string, caseId: string): string {
  const trimmed = origin.replace(/\/+$/, "");
  return `${trimmed}/cases/${caseId}`;
}

export async function createHandoffPacket(
  request: HandoffRequest
): Promise<HandoffResult> {
  const targetConfig = getTargetConfig(request.target);
  if (targetConfig.notYetAvailable) {
    throw new HandoffError(
      "target_unavailable",
      targetConfig.notYetAvailable.reason,
      501
    );
  }

  const caseRecord = await loadCaseForHandoff(request.userId, request.caseId);
  if (!caseRecord) {
    throw new HandoffError("case_not_found", "Case not found.", 404);
  }

  // Resolve diagnosis: explicit id wins, otherwise fall back to the latest.
  const diagnosis = request.diagnosisId
    ? await getDiagnosisForUser(request.userId, request.diagnosisId)
    : await getLatestDiagnosisForCase(request.userId, request.caseId);

  if (!diagnosis) {
    throw new HandoffError(
      "diagnosis_missing",
      "This case has no diagnosis snapshot yet. Run analysis first.",
      409
    );
  }

  if (diagnosis.caseId !== request.caseId) {
    throw new HandoffError(
      "diagnosis_not_found",
      "The requested diagnosis does not belong to this case.",
      404
    );
  }

  const evidence = await listEvidenceForCase(request.userId, request.caseId);

  const input: HandoffPacketInput = {
    caseRecord: {
      id: caseRecord.id,
      title: caseRecord.title,
      userProblemStatement: caseRecord.userProblemStatement,
      severity: caseRecord.severity,
      problemLens: lowercaseEnum(caseRecord.problemLens),
      solveMode: lowercaseEnum(caseRecord.solveMode),
    },
    diagnosis,
    evidence,
    generator: {
      caseUrl: buildCaseUrl(request.requestOrigin, request.caseId),
      generatorVersion: GENERATOR_VERSION,
    },
  };

  // Best-effort repo enrichment (Phase 2.3). Errors are swallowed inside the
  // service — handoff must always produce a packet even when the repo index
  // is unavailable, so `loadRepoEnrichmentForCase` returns undefined in all
  // degraded cases and the builder falls back to its pre-2.3 behaviour.
  try {
    const enrichment = await loadRepoEnrichmentForCase({
      userId: request.userId,
      caseId: request.caseId,
      input,
    });
    if (enrichment) {
      input.repoEnrichment = enrichment;
    }
  } catch (error) {
    console.warn("[handoff] repo enrichment failed; continuing unenriched", {
      caseId: request.caseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let packet: HandoffPacket;
  try {
    packet = buildHandoffPacket(input);
  } catch (error) {
    throw new HandoffError(
      "invariant_violation",
      `Packet build failed: ${(error as Error).message}`,
      500
    );
  }

  const knownEvidenceIds = new Set(evidence.map((item) => item.id));

  // Pre-truncation validation: if the freshly built packet already violates
  // invariants, bail out before we spend effort rendering/truncating.
  try {
    assertPacketValid(packet, knownEvidenceIds);
  } catch (error) {
    throw new HandoffError(
      "invariant_violation",
      `Packet is not ready: ${(error as Error).message}`,
      422
    );
  }

  const truncation = truncatePacketToBudget(packet, knownEvidenceIds, {
    maxBytes: Number.isFinite(targetConfig.budgetBytes)
      ? targetConfig.budgetBytes
      : Number.MAX_SAFE_INTEGER,
  });

  // Truncation may have swapped in the minimal packet. Re-assert before render.
  assertPacketValid(truncation.packet, knownEvidenceIds);

  const rendered = targetConfig.render(truncation.packet);
  const handoffRow = await prisma.targHandoff.create({
    data: {
      caseId: request.caseId,
      diagnosisId: diagnosis.id,
      workBundleId: request.workBundleId ?? null,
      target: toPrismaHandoffTarget(request.target) as
        | "CURSOR"
        | "CLAUDE_CODE"
        | "CODEX"
        | "COPILOT_WS"
        | "GITHUB_ISSUE"
        | "LINEAR_ISSUE"
        | "MARKDOWN",
      packetMd: rendered.body,
      packetJson: truncation.packet as unknown as object,
      externalRef: null,
      truncationSteps: {
        steps: truncation.steps,
        usedMinimalPacket: truncation.usedMinimalPacket,
      },
      createdByUserId: request.userId,
    },
    select: { id: true },
  });

  return {
    handoffId: handoffRow.id,
    target: request.target,
    kind: targetConfig.kind,
    packetMd: rendered.body,
    url: rendered.url,
    truncationSteps: truncation.steps,
    usedMinimalPacket: truncation.usedMinimalPacket,
  };
}

export async function listHandoffsForCase(
  userId: string,
  caseId: string
): Promise<
  Array<{
    id: string;
    target: HandoffTargetId;
    createdAt: string;
    externalRef: string | null;
    usedMinimalPacket: boolean;
  }>
> {
  const caseRecord = await loadCaseForHandoff(userId, caseId);
  if (!caseRecord) {
    throw new HandoffError("case_not_found", "Case not found.", 404);
  }

  const rows = await prisma.targHandoff.findMany({
    where: { caseId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      target: true,
      createdAt: true,
      externalRef: true,
      truncationSteps: true,
    },
  });

  return rows.map((row) => {
    const truncation = row.truncationSteps as
      | { usedMinimalPacket?: boolean }
      | null;
    return {
      id: row.id,
      target: row.target.toLowerCase() as HandoffTargetId,
      createdAt: row.createdAt.toISOString(),
      externalRef: row.externalRef,
      usedMinimalPacket: Boolean(truncation?.usedMinimalPacket),
    };
  });
}

// Re-exported for callers that need to render an already-persisted packet,
// e.g. replaying an older handoff when debugging a receiver.
export { getEvidenceForUser };
