import {
  buildCaseMemory,
  ingestEvidence,
  refreshScreenshotEvidenceForCase,
} from "@/lib/services/evidence-service";

export async function runEvidenceJobs(evidenceId: string, caseId: string) {
  await ingestEvidence(evidenceId);
  await refreshScreenshotEvidenceForCase(caseId, evidenceId);
  await buildCaseMemory(caseId);
}
