import { processAnalysisRun } from "@/lib/services/analysis-service";

export async function runAnalysisJobs(runId: string) {
  await processAnalysisRun(runId);
}
