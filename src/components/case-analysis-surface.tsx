"use client";

import type { CaseProblemLens } from "@prisma/client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { CaseAiDiagnosis } from "@/components/case-ai-diagnosis";
import { CaseProblemBrief } from "@/components/case-problem-brief";
import { CaseUnknownsBlockers } from "@/components/case-unknowns-blockers";
import { CaseWhyThisPlan } from "@/components/case-why-this-plan";
import { CaseWorkPlan } from "@/components/case-work-plan";
import { DIAGNOSIS_CONFIDENCE_LABELS } from "@/lib/analysis/constants";
import { cn } from "@/lib/utils/cn";
import type {
  ActionDraftViewModel,
  AnalysisRunViewModel,
  BreakdownViewModel,
  DiagnosisSnapshotViewModel,
  WorkBundleViewModel,
} from "@/lib/analysis/view-model";
import type { CaseSolveModeValue } from "@/lib/planning/intake-preferences";

type CaseAnalysisSurfaceProps = {
  caseId: string;
  caseTitle: string;
  userProblemStatement: string;
  caseProblemLens?: CaseProblemLens | null;
  initialRun: AnalysisRunViewModel | null;
  initialDiagnosis: DiagnosisSnapshotViewModel | null;
  diagnosisHistory: DiagnosisSnapshotViewModel[];
  currentEvidenceVersion: number;
  draft: ActionDraftViewModel | null;
  draftReason: string | null;
  breakdown: BreakdownViewModel | null;
  workBundle: WorkBundleViewModel | null;
  isRegeneratingDraft: boolean;
  onReviewDraft: () => void;
  onRegenerateDraft: () => void;
  onOpenInspect: (tab: "Relevant" | "Uploads" | "Issues") => void;
  onOpenEvidenceWorkspace: () => void;
  planSolveMode: CaseSolveModeValue | null;
  onPlanDepthChange: (mode: CaseSolveModeValue) => void;
  planDepthSaving: boolean;
  onRunChange?: (run: AnalysisRunViewModel | null) => void;
  onDiagnosisChange?: (diagnosis: DiagnosisSnapshotViewModel | null) => void;
  onSelectClaimKey?: (claimKey: string | null) => void;
  /** Renders without outer Surface; use inside CaseViewShell’s unified sheet. */
  embedded?: boolean;
};

type RunResponse = {
  run: AnalysisRunViewModel;
};

type DiagnosisResponse = {
  diagnosis: DiagnosisSnapshotViewModel;
};

export function CaseAnalysisSurface({
  caseId,
  caseTitle,
  userProblemStatement,
  caseProblemLens = null,
  initialRun,
  initialDiagnosis,
  diagnosisHistory,
  currentEvidenceVersion,
  draft,
  draftReason,
  breakdown,
  workBundle,
  isRegeneratingDraft,
  onReviewDraft,
  onRegenerateDraft,
  onOpenInspect,
  onOpenEvidenceWorkspace,
  planSolveMode,
  onPlanDepthChange,
  planDepthSaving,
  onRunChange,
  onDiagnosisChange,
  onSelectClaimKey,
  embedded = false,
}: CaseAnalysisSurfaceProps) {
  const router = useRouter();
  const [currentRun, setCurrentRun] = useState(initialRun);
  const [diagnosis, setDiagnosis] = useState(initialDiagnosis);
  const [activeDiagnosisId, setActiveDiagnosisId] = useState<string | null>(
    initialDiagnosis?.id ?? null
  );
  const [error, setError] = useState<string | null>(null);
  const [isAnswering, setIsAnswering] = useState(false);

  useEffect(() => {
    setCurrentRun(initialRun);
  }, [initialRun]);

  useEffect(() => {
    setDiagnosis(initialDiagnosis);
    setActiveDiagnosisId(initialDiagnosis?.id ?? null);
  }, [initialDiagnosis]);

  useEffect(() => {
    onRunChange?.(currentRun);
  }, [currentRun, onRunChange]);

  useEffect(() => {
    onDiagnosisChange?.(diagnosis);
  }, [diagnosis, onDiagnosisChange]);

  const activeDiagnosis =
    diagnosisHistory.find((item) => item.id === activeDiagnosisId) ??
    diagnosis ??
    initialDiagnosis ??
    diagnosisHistory[0] ??
    null;

  const diagnosisIsStale =
    activeDiagnosis !== null &&
    currentEvidenceVersion > activeDiagnosis.caseEvidenceVersion;

  const historyItems = diagnosisHistory;
  const activeBreakdown =
    activeDiagnosis && breakdown?.diagnosisSnapshotId === activeDiagnosis.id
      ? breakdown
      : null;
  const activeWorkBundle =
    activeDiagnosis && workBundle?.diagnosisSnapshotId === activeDiagnosis.id
      ? workBundle
      : null;

  const refreshLatestDiagnosis = useCallback(async () => {
    const response = await fetch(`/api/cases/${caseId}/diagnosis/latest`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as DiagnosisResponse;
    setDiagnosis(data.diagnosis);
    setActiveDiagnosisId(data.diagnosis.id);
    return data.diagnosis;
  }, [caseId]);

  const refreshRun = useCallback(async () => {
    if (!currentRun) {
      return null;
    }

    const response = await fetch(`/api/runs/${currentRun.id}`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error("Could not refresh analysis run.");
    }

    const data = (await response.json()) as RunResponse;
    setCurrentRun(data.run);

    if (data.run.status === "ready") {
      await refreshLatestDiagnosis();
      router.refresh();
    }

    return data.run;
  }, [currentRun, refreshLatestDiagnosis, router]);

  useEffect(() => {
    if (!currentRun || currentRun.status !== "analyzing") {
      return;
    }

    const intervalId = window.setInterval(() => {
      refreshRun().catch(() => undefined);
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [currentRun, refreshRun]);

  async function handleAnswer(answer: string) {
    if (!currentRun) {
      return;
    }

    setError(null);
    setIsAnswering(true);

    try {
      const response = await fetch(`/api/runs/${currentRun.id}/answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ answer }),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string; run?: AnalysisRunViewModel }
        | null;

      if (!response.ok || !data?.run) {
        setError(data?.error ?? "Could not submit answer.");
        return;
      }

      setCurrentRun(data.run);
    } catch {
      setError("Request failed. Try again.");
    } finally {
      setIsAnswering(false);
    }
  }

  function handleSelectClaimKey(claimKey: string | null) {
    onSelectClaimKey?.(claimKey);
  }

  const showRunBanner =
    currentRun?.status === "analyzing" || currentRun?.status === "needs_input";

  const needsClarification =
    currentRun?.status === "needs_input" &&
    Boolean(currentRun.pendingQuestion);

  const clarificationBlock =
    needsClarification && currentRun ? (
      <CaseUnknownsBlockers
        pendingQuestion={currentRun.pendingQuestion!}
        pendingOptions={currentRun.pendingOptions}
        questionCount={currentRun.questionCount}
        isAnswering={isAnswering}
        onSelectOption={handleAnswer}
        onOpenEvidenceWorkspace={onOpenEvidenceWorkspace}
      />
    ) : null;

  const inner = (
    <>
      {error ? (
        <div className="targ-callout-critical">{error}</div>
      ) : null}

      {showRunBanner && currentRun?.status === "analyzing" ? (
        <p className="text-[14px] leading-[21px] text-[var(--color-text-secondary)]">
          Working through what you uploaded—usually finishes in a few seconds.
        </p>
      ) : null}

      {!activeDiagnosis && clarificationBlock ? (
        <div className="mt-4">{clarificationBlock}</div>
      ) : null}

      {currentRun?.status === "failed" ? (
        <div className="targ-callout-critical rounded-[var(--radius-md)] px-5 py-4 text-sm leading-[21px]">
          {currentRun.failureMessage ??
            "Run failed. Add evidence or run analysis again from the header."}
        </div>
      ) : null}

      {activeDiagnosis ? (
        <div className="divide-y divide-[var(--color-border-subtle)]/70">
          <div className="pb-6">
            <CaseAiDiagnosis
              caseId={caseId}
              diagnosis={activeDiagnosis}
              breakdown={activeBreakdown}
              workBundle={activeWorkBundle}
              diagnosisIsStale={diagnosisIsStale}
              onOpenProof={(claimKey) => handleSelectClaimKey(claimKey)}
              onOpenEvidence={onOpenEvidenceWorkspace}
              onOpenIssues={() => onOpenInspect("Issues")}
            />
          </div>

          <div className="py-6">
            <CaseWorkPlan
              diagnosis={activeDiagnosis}
              draft={draft}
              draftReason={draftReason}
              breakdown={activeBreakdown}
              workBundle={activeWorkBundle}
              isRegenerating={isRegeneratingDraft}
              onReviewDraft={onReviewDraft}
              onRegenerateDraft={onRegenerateDraft}
              onOpenProof={(claimKey) => handleSelectClaimKey(claimKey)}
              onOpenInspectUploads={() => onOpenInspect("Uploads")}
              planSolveMode={planSolveMode}
              onPlanDepthChange={onPlanDepthChange}
              planDepthSaving={planDepthSaving}
            />
          </div>

          {clarificationBlock ? (
            <div className="py-6">{clarificationBlock}</div>
          ) : null}

          <div className="py-6 space-y-3">
            <CaseProblemBrief
              caseTitle={caseTitle}
              userProblemStatement={userProblemStatement}
              caseProblemLens={caseProblemLens}
              diagnosis={activeDiagnosis}
              draft={draft}
              breakdown={activeBreakdown}
              workBundle={activeWorkBundle}
            />
            <CaseWhyThisPlan
              diagnosis={activeDiagnosis}
              draft={draft}
              onOpenProof={(claimKey) => handleSelectClaimKey(claimKey)}
              onOpenInspectUploads={() => onOpenInspect("Uploads")}
            />

            {historyItems.length > 1 ? (
              <details className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/70 bg-[rgba(255,255,255,0.015)] px-3 py-3">
                <summary className="flex cursor-pointer list-none flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                      Earlier reads
                    </p>
                    <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                      Older snapshots stay available when you want to compare the case over time.
                    </p>
                  </div>
                  <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                    {historyItems.length} total
                  </span>
                </summary>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {historyItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setDiagnosis(item);
                        setActiveDiagnosisId(item.id);
                        handleSelectClaimKey(item.trace[0]?.claimKey ?? null);
                      }}
                      className={cn(
                        "rounded-[var(--radius-pill)] px-3 py-1 text-[12px] font-semibold transition-colors duration-[var(--motion-base)]",
                        item.id === activeDiagnosis.id
                          ? "bg-[var(--color-accent-primary)] text-[#0e1214]"
                          : "text-[var(--color-text-muted)] hover:bg-[rgba(255,255,255,0.04)] hover:text-[var(--color-text-secondary)]"
                      )}
                    >
                      {DIAGNOSIS_CONFIDENCE_LABELS[item.confidence]}
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="py-10">
          {currentRun?.status === "analyzing" ? (
            <p className="text-center text-[15px] leading-[24px] text-[var(--color-text-secondary)]">
              Building the read from your evidence…
            </p>
          ) : (
            <p className="max-w-xl text-[15px] leading-[24px] text-[var(--color-text-secondary)]">
              Add what you have below, then run analysis from the top of the
              case. Targ only renders a read once there is evidence to weigh.
            </p>
          )}
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="px-5 pb-8 pt-4 sm:px-8 sm:pb-9 sm:pt-5">
        <div className="mx-auto w-full max-w-[52rem] space-y-5 lg:max-w-[58rem] sm:space-y-6 xl:max-w-[64rem]">
          {inner}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="targ-surface-raised rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-6 sm:p-8">
        <div className="mx-auto w-full max-w-[52rem] space-y-6 lg:max-w-[58rem] xl:max-w-[64rem]">
          {inner}
        </div>
      </div>
    </div>
  );
}
