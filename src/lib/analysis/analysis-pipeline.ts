/**
 * Targ full analysis pipeline — one main run, no multi-agent swarm.
 *
 * Orchestration lives in `runInvestigatorForRun` (analysis-service) + `persistPlanningAfterDiagnosis`
 * (planning-service). This module is the contract doc and stage vocabulary for traces/UI.
 *
 * ## Stages (in order)
 *
 * 1. **Understand** — Build case memory from DB; optional clarifying questions (`askUser`);
 *    gates on evidence readiness. No separate “agent.”
 *
 * 2. **Structured read (diagnosis snapshot)** — `buildDiagnosisFromMemory` + `runVerifier`;
 *    persist append-only `TargDiagnosisSnapshot` (+ problem brief). Feeds all downstream stages.
 *
 * 3. **Classify** — `classifyProblemFromDiagnosis` → `ProblemClassification` (primary + optional
 *    secondaries for mixed cases). Today: deterministic; swap-in: one JSON LLM call using the same
 *    inputs if you need richer taxonomy.
 *
 * 4. **Decompose** — `decomposeFromDiagnosis` → `BreakdownDocument` (hypotheses, unknowns,
 *    evidence anchors, mode extensions). Tasks must be derived from this graph, not free-form lists.
 *
 * 5. **Work bundle** — `buildWorkBundleFromBreakdown` → `WorkBundlePayload` (grouped, typed,
 *    sequenced tasks). Optional alternative paths: extra task groups or `alternativePaths` once
 *    represented in `bundle-types`; justify only when hypotheses diverge.
 *
 * 6. **Verify bundle** — `verifyWorkBundle` (deterministic): caps, fix vs investigation policy,
 *    vague/unlinked tasks, sequencing normalization, kind downgrades.
 *
 * ## Fix-ready vs investigation-ready
 *
 * `WorkBundleKind` is set from diagnosis confidence + next-action policy, then **re-validated**
 * in stage 6 so surfaced bundles never promise `implement` when the read forbids it.
 */

export const analysisPipelineStage = {
  understand: "understand",
  diagnosisSnapshot: "diagnosis_snapshot",
  classify: "classify",
  decompose: "decompose",
  workBundle: "work_bundle",
  verifyBundle: "verify_bundle",
} as const;

export type AnalysisPipelineStageId =
  (typeof analysisPipelineStage)[keyof typeof analysisPipelineStage];
