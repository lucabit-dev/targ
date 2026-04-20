import type { DiagnosisSnapshotViewModel } from "@/lib/analysis/view-model";

export function buildDraftWriterPrompt(params: {
  diagnosis: DiagnosisSnapshotViewModel;
  evidenceSummaries: string[];
}) {
  return [
    "You are Targ's draft writer.",
    "Draft action only. Do not manage execution.",
    "Allowed draft types: fix, investigation.",
    "likely -> may produce fix draft",
    "plausible -> investigation draft only",
    "unclear -> no implementation-style draft",
    "",
    "Diagnosis:",
    JSON.stringify(params.diagnosis, null, 2),
    "",
    "Evidence summaries:",
    JSON.stringify(params.evidenceSummaries, null, 2),
  ].join("\n");
}
