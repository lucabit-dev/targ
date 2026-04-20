"use client";

import type { CaseProblemLens, CaseSolveMode } from "@prisma/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatRelativeDate } from "@/lib/utils/format";

import { CaseAnalysisSurface } from "@/components/case-analysis-surface";
import { CaseEvidenceWorkspace } from "@/components/case-evidence-workspace";
import {
  CaseRepoLinkPicker,
  type CaseRepoLinkSummary,
} from "@/components/case-repo-link-picker";
import { DraftReviewSheet } from "@/components/draft-review-sheet";
import { InspectPanel } from "@/components/inspect-panel";
import { Button, Chip, Surface } from "@/components/ui/primitives";
import { CASE_LIST_CONFIDENCE_CHIP } from "@/lib/case-list-status";
import {
  problemLensDisplayLabel,
  solveModeFromPrisma,
  type CaseSolveModeValue,
} from "@/lib/planning/intake-preferences";
import type {
  ActionDraftViewModel,
  AnalysisRunViewModel,
  BreakdownViewModel,
  DiagnosisSnapshotViewModel,
  WorkBundleViewModel,
} from "@/lib/analysis/view-model";
import type { EvidenceViewModel } from "@/lib/evidence/view-model";

type CaseViewShellProps = {
  caseId: string;
  caseWorkspaceId: string;
  caseTitle: string;
  caseProblemStatement: string;
  caseProblemLens?: CaseProblemLens | null;
  caseUpdatedAt: Date | string;
  caseWorkflowState: string;
  caseAnalysisState: string;
  caseDraftState?: string;
  caseConfidence?: string | null;
  initialEvidence: EvidenceViewModel[];
  initialRun: AnalysisRunViewModel | null;
  initialDiagnosis: DiagnosisSnapshotViewModel | null;
  diagnosisHistory: DiagnosisSnapshotViewModel[];
  initialDraft: ActionDraftViewModel | null;
  initialDraftReason: string | null;
  initialSolveMode?: CaseSolveMode | null;
  initialBreakdown: BreakdownViewModel | null;
  initialWorkBundle: WorkBundleViewModel | null;
  initialRepoLink: CaseRepoLinkSummary | null;
};

type DraftResponse = {
  draft: ActionDraftViewModel | null;
  reason: string | null;
};

export function CaseViewShell({
  caseId,
  caseWorkspaceId,
  caseTitle,
  caseProblemStatement,
  caseProblemLens = null,
  caseUpdatedAt,
  caseWorkflowState,
  caseAnalysisState,
  caseDraftState,
  caseConfidence,
  initialEvidence,
  initialRun,
  initialDiagnosis,
  diagnosisHistory,
  initialDraft,
  initialDraftReason,
  initialSolveMode = null,
  initialBreakdown,
  initialWorkBundle,
  initialRepoLink,
}: CaseViewShellProps) {
  const router = useRouter();
  const [evidence, setEvidence] = useState(initialEvidence);
  const [currentRun, setCurrentRun] = useState<AnalysisRunViewModel | null>(initialRun);
  const [currentDiagnosis, setCurrentDiagnosis] =
    useState<DiagnosisSnapshotViewModel | null>(initialDiagnosis);
  const [selectedClaimKey, setSelectedClaimKey] = useState<string | null>(
    initialDiagnosis?.trace[0]?.claimKey ?? null
  );
  const [draft, setDraft] = useState<ActionDraftViewModel | null>(initialDraft);
  const [draftReason, setDraftReason] = useState<string | null>(initialDraftReason);
  const [isDraftSheetOpen, setIsDraftSheetOpen] = useState(false);
  const [isRegeneratingDraft, setIsRegeneratingDraft] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isInspectOpen, setIsInspectOpen] = useState(false);
  const [isEvidenceOpen, setIsEvidenceOpen] = useState(false);
  const [planSolveMode, setPlanSolveMode] = useState<CaseSolveModeValue | null>(
    () => solveModeFromPrisma(initialSolveMode)
  );
  const [planDepthSaving, setPlanDepthSaving] = useState(false);
  const [inspectTab, setInspectTab] = useState<"Relevant" | "Uploads" | "Issues">(
    "Uploads"
  );

  useEffect(() => {
    setEvidence(initialEvidence);
  }, [initialEvidence]);

  useEffect(() => {
    setCurrentRun(initialRun);
  }, [initialRun]);

  useEffect(() => {
    setCurrentDiagnosis(initialDiagnosis);
    setSelectedClaimKey(initialDiagnosis?.trace[0]?.claimKey ?? null);
  }, [initialDiagnosis]);

  useEffect(() => {
    setDraft(initialDraft);
    setDraftReason(initialDraftReason);
  }, [initialDraft, initialDraftReason]);

  useEffect(() => {
    setPlanSolveMode(solveModeFromPrisma(initialSolveMode));
  }, [initialSolveMode]);

  const currentEvidenceVersion = useMemo(
    () =>
      evidence.reduce(
        (maxVersion, item) => Math.max(maxVersion, item.caseEvidenceVersion),
        0
      ),
    [evidence]
  );

  const closeInspectPanel = useCallback(() => {
    setIsInspectOpen(false);
  }, []);

  const closeEvidencePanel = useCallback(() => {
    setIsEvidenceOpen(false);
  }, []);

  const openEvidencePanel = useCallback(() => {
    setIsEvidenceOpen(true);
  }, []);

  const handlePlanDepthChange = useCallback(
    async (mode: CaseSolveModeValue) => {
      if (planSolveMode === mode) {
        return;
      }
      const previous = planSolveMode;
      setPlanSolveMode(mode);
      setPlanDepthSaving(true);
      try {
        const response = await fetch(`/api/cases/${caseId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ solveMode: mode }),
        });

        if (!response.ok) {
          throw new Error("Could not update plan depth.");
        }
        router.refresh();
      } catch {
        setPlanSolveMode(previous);
      } finally {
        setPlanDepthSaving(false);
      }
    },
    [caseId, planSolveMode, router]
  );

  const handleSelectClaimKey = useCallback((claimKey: string | null) => {
    setSelectedClaimKey(claimKey);
    if (claimKey) {
      setInspectTab("Relevant");
      setIsInspectOpen(true);
    }
  }, []);

  const handleOpenInspect = useCallback((tab: "Relevant" | "Uploads" | "Issues") => {
    setInspectTab(tab);
    setIsInspectOpen(true);
  }, []);

  useEffect(() => {
    if (!isInspectOpen && !isEvidenceOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (isDraftSheetOpen) {
        return;
      }
      event.preventDefault();
      if (isInspectOpen) {
        closeInspectPanel();
        return;
      }
      closeEvidencePanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    closeEvidencePanel,
    closeInspectPanel,
    isDraftSheetOpen,
    isEvidenceOpen,
    isInspectOpen,
  ]);

  useEffect(() => {
    if (!isInspectOpen && !isEvidenceOpen) {
      return;
    }
    const media = window.matchMedia("(max-width: 639px)");
    const syncBodyScroll = () => {
      document.body.style.overflow = media.matches ? "hidden" : "";
    };
    syncBodyScroll();
    media.addEventListener("change", syncBodyScroll);
    return () => {
      media.removeEventListener("change", syncBodyScroll);
      document.body.style.overflow = "";
    };
  }, [isEvidenceOpen, isInspectOpen]);

  function deriveCaseStatusLabel() {
    if (currentRun?.status === "needs_input") {
      return "Reply needed";
    }

    if (currentRun?.status === "analyzing") {
      return "Running read";
    }

    if (currentRun?.status === "failed" || caseAnalysisState === "FAILED") {
      return "Read failed";
    }

    if (caseDraftState === "READY" && draft) {
      return "Review draft";
    }

    if (currentDiagnosis || caseAnalysisState === "READY") {
      return "AI diagnosis ready";
    }

    if (caseWorkflowState === "RESOLVED") {
      return "Resolved";
    }

    return "Needs a read";
  }

  const confidenceState = resolveConfidenceLabel();

  function resolveConfidenceLabel() {
    const confidence = currentDiagnosis?.confidence ?? caseConfidence?.toLowerCase() ?? null;

    if (!confidence) {
      return null;
    }

    if (confidence === "likely") {
      return {
        label: CASE_LIST_CONFIDENCE_CHIP.likely,
        tone: "confidence" as const,
      };
    }

    if (confidence === "plausible") {
      return {
        label: CASE_LIST_CONFIDENCE_CHIP.plausible,
        tone: "confidence" as const,
      };
    }

    return {
      label: CASE_LIST_CONFIDENCE_CHIP.unclear,
      tone: "warning" as const,
    };
  }

  const handleStartAnalysis = useCallback(async () => {
    setCurrentRun((current) =>
      current
        ? {
            ...current,
            status: "analyzing",
          }
        : current
    );

    const response = await fetch(`/api/cases/${caseId}/analyze`, {
      method: "POST",
    });

    const data = (await response.json().catch(() => null)) as
      | { run?: AnalysisRunViewModel; error?: string }
      | null;

    if (!response.ok || !data?.run) {
      throw new Error(data?.error ?? "Could not start analysis.");
    }

    setCurrentRun(data.run);
    return data.run;
  }, [caseId]);

  const evidenceParsing = useMemo(
    () => evidence.some((item) => item.ingestStatus === "parsing"),
    [evidence]
  );
  const evidenceParsingCount = useMemo(
    () => evidence.filter((item) => item.ingestStatus === "parsing").length,
    [evidence]
  );
  const diagnosisIsStale =
    currentDiagnosis !== null &&
    currentEvidenceVersion > currentDiagnosis.caseEvidenceVersion;
  const draftIsStale =
    Boolean(draft && currentDiagnosis && draft.diagnosisSnapshotId !== currentDiagnosis.id);
  const newEvidenceSinceReadCount = useMemo(() => {
    if (!currentDiagnosis) {
      return 0;
    }

    return evidence.filter(
      (item) => item.caseEvidenceVersion > currentDiagnosis.caseEvidenceVersion
    ).length;
  }, [currentDiagnosis, evidence]);

  const headerGuidance = useMemo(() => {
    if (currentRun?.status === "needs_input") {
      return {
        eyebrow: "Waiting on you",
        title: "A clarifying answer is blocking the next diagnosis step.",
        body: "Open the case body and answer the current question before adding more noise.",
      };
    }

    if (diagnosisIsStale) {
      return {
        eyebrow: "Evidence changed",
        title: "This diagnosis no longer reflects the latest evidence set.",
        body: initialWorkBundle
          ? "Re-run analysis now to refresh the analysis, proof links, and work system."
          : "Re-run analysis now to refresh the diagnosis, proof links, and work plan.",
      };
    }

    if (currentRun?.status === "analyzing") {
      return {
        eyebrow: "Diagnosis running",
        title: "Targ is reading the current evidence set.",
        body: "Stay here if you want, or add more context once this pass finishes.",
      };
    }

    if (currentRun?.status === "failed" || caseAnalysisState === "FAILED") {
      return {
        eyebrow: "Run failed",
        title: "The last diagnosis did not complete cleanly.",
        body: "Try another run or add a sharper log, trace, or reproduction note first.",
      };
    }

    if (draft?.status === "saved") {
      return {
        eyebrow: "Saved handoff",
        title: draftIsStale
          ? "Your saved draft is older than the current diagnosis."
          : initialWorkBundle
            ? "Analysis, work system, and saved draft are ready on this case."
            : "Diagnosis and saved draft are both ready on this case.",
        body: draftIsStale
          ? initialWorkBundle
            ? "Review the updated work system and regenerate the draft if you still want a handoff."
            : "Review the updated work plan and regenerate the draft if you still want a handoff."
          : "Open the draft if you want the checklist, or inspect proof before acting.",
      };
    }

    if (draft) {
      return {
        eyebrow: "Draft ready",
        title: initialWorkBundle
          ? "The analysis is ready and a draft is waiting beside the work system."
          : "The diagnosis is ready and a draft is waiting for review.",
        body: initialWorkBundle
          ? "Review the work system below, then save the draft only if you want a pinned handoff."
          : "Check the work plan below, then save the draft only if you want it pinned on the case.",
      };
    }

    if (currentDiagnosis || caseAnalysisState === "READY") {
      return {
        eyebrow: initialWorkBundle ? "AI work system ready" : "AI diagnosis ready",
        title: initialWorkBundle
          ? "Targ turned the evidence into a diagnosis and a task system to move the case forward."
          : "Targ produced a diagnosis and a recommended next move from the current evidence.",
        body: initialWorkBundle
          ? "Review the AI diagnosis first, then work through the recommended task tracks or tighten the evidence."
          : "Review the diagnosis below, inspect proof, or add new evidence if the picture still feels incomplete.",
      };
    }

    if (evidence.length > 0) {
      return {
        eyebrow: "Ready for analysis",
        title: "Evidence is attached. Run analysis when you want the first AI diagnosis.",
        body: "You can still add more proof first if the strongest signal is not here yet.",
      };
    }

    return {
      eyebrow: "Case intake",
      title: "Start by adding evidence before asking Targ for an AI diagnosis.",
      body: "A log tail, screenshot note, stack trace, or short reproduction note is enough to begin.",
    };
  }, [
    caseAnalysisState,
    currentDiagnosis,
    currentRun,
    diagnosisIsStale,
    draft,
    draftIsStale,
    evidence.length,
    initialWorkBundle,
  ]);

  const primaryAction = useMemo(() => {
    if (diagnosisIsStale || (!currentDiagnosis && evidence.length > 0)) {
      return {
        label: diagnosisIsStale ? "Re-run analysis" : "Run analysis",
        onClick: handleStartAnalysis,
        variant: "primary" as const,
      };
    }

    if (draft) {
      return {
        label: draft.status === "saved" ? "Open saved handoff" : "Review handoff",
        onClick: () => setIsDraftSheetOpen(true),
        variant: "primary" as const,
      };
    }

    return {
      label: "Add evidence",
      onClick: openEvidencePanel,
      variant: "secondary" as const,
    };
  }, [currentDiagnosis, diagnosisIsStale, draft, evidence.length, handleStartAnalysis, openEvidencePanel]);

  const refreshDraft = useCallback(async () => {
    const response = await fetch(`/api/cases/${caseId}/draft`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error("Could not refresh draft.");
    }

    const data = (await response.json()) as DraftResponse;
    setDraft(data.draft);
    setDraftReason(data.reason);
    return data;
  }, [caseId]);

  useEffect(() => {
    if (!currentDiagnosis) {
      setDraft(null);
      setDraftReason("Run analysis first; drafts attach to a diagnosis.");
      return;
    }

    refreshDraft().catch(() => undefined);
  }, [currentDiagnosis, refreshDraft]);

  async function handleRegenerateDraft() {
    setIsRegeneratingDraft(true);

    try {
      const response = await fetch(`/api/cases/${caseId}/draft/regenerate`, {
        method: "POST",
      });

      const data = (await response.json().catch(() => null)) as
        | { draft?: ActionDraftViewModel | null; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(data?.error ?? "Could not regenerate draft.");
      }

      setDraft(data?.draft ?? null);
      setDraftReason(
        data?.draft
          ? null
          : "Policy: no implementation-style draft for this reading."
      );
    } catch {
      setDraftReason("Regenerate failed. Try again.");
    } finally {
      setIsRegeneratingDraft(false);
    }
  }

  async function handleSaveDraft() {
    if (!draft) {
      return;
    }

    setIsSavingDraft(true);

    try {
      const response = await fetch(`/api/drafts/${draft.id}/save`, {
        method: "POST",
      });

      const data = (await response.json().catch(() => null)) as
        | { draft?: ActionDraftViewModel; error?: string }
        | null;

      if (!response.ok || !data?.draft) {
        throw new Error(data?.error ?? "Could not save draft.");
      }

      setDraft(data.draft);
      setDraftReason(null);
    } finally {
      setIsSavingDraft(false);
    }
  }

  return (
    <div className="space-y-0">
      <Surface
        tone="raised"
        padding="none"
        className="targ-fade-panel overflow-hidden"
      >
        <header className="border-b border-[var(--color-border-subtle)] px-5 py-2.5 sm:px-8 sm:py-3">
          <div className="mx-auto w-full max-w-[52rem] lg:max-w-[58rem] xl:max-w-[64rem]">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:gap-x-6 lg:gap-y-0">
              <div className="min-w-0">
                <h1 className="truncate text-[1.5rem] font-semibold leading-[1.35] tracking-[-0.03em] text-[var(--color-text-primary)] sm:text-[1.625rem] sm:leading-[1.3]">
                  {caseTitle}
                </h1>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className="text-[11px] font-semibold leading-4 text-[var(--color-text-secondary)]"
                    title={
                      caseProblemLens
                        ? "Problem lens set at intake."
                        : "Problem lens not pinned; Targ infers from what you add."
                    }
                  >
                    {problemLensDisplayLabel(caseProblemLens)}
                  </span>
                  <span
                    className="select-none text-[11px] text-[var(--color-text-muted)] opacity-50"
                    aria-hidden
                  >
                    ·
                  </span>
                  <Chip
                    title="Stage from the latest run and read on this case."
                    className="min-h-[22px] rounded-[5px] px-2 py-0 text-[11px] font-semibold leading-4 tracking-[0.02em]"
                  >
                    {deriveCaseStatusLabel()}
                  </Chip>
                  {confidenceState ? (
                    <>
                      <span
                        className="select-none text-[11px] text-[var(--color-text-muted)] opacity-50"
                        aria-hidden
                      >
                        ·
                      </span>
                      <span
                        className={
                          confidenceState.tone === "warning"
                            ? "text-[11px] font-semibold leading-4 text-[var(--color-state-warning)]"
                            : "text-[11px] font-semibold leading-4 text-[var(--color-text-secondary)]"
                        }
                        title={
                          confidenceState.tone === "warning"
                            ? "Low confidence in this read—verify before high-risk decisions."
                            : "Strength of the latest diagnosis for this snapshot."
                        }
                      >
                        {confidenceState.label}
                      </span>
                    </>
                  ) : null}
                  <span
                    className="select-none text-[11px] text-[var(--color-text-muted)] opacity-50"
                    aria-hidden
                  >
                    ·
                  </span>
                  <time
                    className="targ-meta tabular-nums text-[11px] font-medium leading-4 text-[var(--color-text-muted)]"
                    dateTime={
                      typeof caseUpdatedAt === "string"
                        ? caseUpdatedAt
                        : caseUpdatedAt.toISOString()
                    }
                  >
                    Updated {formatRelativeDate(caseUpdatedAt)}
                  </time>
                  <span
                    className="select-none text-[11px] text-[var(--color-text-muted)] opacity-50"
                    aria-hidden
                  >
                    ·
                  </span>
                  <CaseRepoLinkPicker
                    caseId={caseId}
                    workspaceId={caseWorkspaceId}
                    initialRepoLink={initialRepoLink}
                  />
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] leading-[18px]">
                  <span className="font-semibold uppercase tracking-[0.08em] text-[var(--color-accent-primary)]">
                    {headerGuidance.eyebrow}
                  </span>
                  <span className="text-[var(--color-text-primary)]">
                    {headerGuidance.title}
                  </span>
                  {evidenceParsing ? (
                    <span className="text-[var(--color-state-warning)]">
                      {evidenceParsingCount === 1
                        ? "1 evidence item is still parsing."
                        : `${evidenceParsingCount} evidence items are still parsing.`}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                  {headerGuidance.body}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 lg:justify-end lg:pt-0.5">
                <Button
                  variant={primaryAction.variant}
                  type="button"
                  onClick={primaryAction.onClick}
                  className="min-h-8 rounded-[var(--radius-sm)] px-2.5 py-0 text-[12px] leading-4 font-semibold"
                >
                  {primaryAction.label}
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={openEvidencePanel}
                  className="min-h-8 rounded-[var(--radius-sm)] px-2.5 py-0 text-[12px] leading-4 font-semibold"
                >
                  Add evidence
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setIsDraftSheetOpen(true)}
                  disabled={!draft}
                  className="min-h-8 rounded-[var(--radius-sm)] px-2.5 py-0 text-[12px] leading-4 font-semibold"
                >
                  {draft?.status === "saved" ? "Saved draft" : "Review draft"}
                </Button>
              </div>
            </div>
          </div>
        </header>

        <CaseAnalysisSurface
          embedded
          caseId={caseId}
          caseTitle={caseTitle}
          userProblemStatement={caseProblemStatement}
          caseProblemLens={caseProblemLens}
          initialRun={currentRun}
          initialDiagnosis={currentDiagnosis}
          diagnosisHistory={diagnosisHistory}
          currentEvidenceVersion={currentEvidenceVersion}
          draft={draft}
          draftReason={draftReason}
          isRegeneratingDraft={isRegeneratingDraft}
          onReviewDraft={() => setIsDraftSheetOpen(true)}
          onRegenerateDraft={handleRegenerateDraft}
          onOpenInspect={handleOpenInspect}
          onOpenEvidenceWorkspace={openEvidencePanel}
          breakdown={initialBreakdown}
          workBundle={initialWorkBundle}
          planSolveMode={planSolveMode}
          onPlanDepthChange={handlePlanDepthChange}
          planDepthSaving={planDepthSaving}
          onRunChange={setCurrentRun}
          onDiagnosisChange={setCurrentDiagnosis}
          onSelectClaimKey={handleSelectClaimKey}
        />
      </Surface>

      <div className="border-t border-[var(--color-border-subtle)]/80 bg-[rgba(0,0,0,0.02)] px-5 py-2.5 sm:px-8">
        <div className="mx-auto flex w-full max-w-[52rem] justify-start lg:max-w-[58rem] xl:max-w-[64rem]">
          <Button
            variant="tertiary"
            type="button"
            onClick={openEvidencePanel}
            className="-ms-1 min-h-8 px-2 text-[12px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            aria-label="Open evidence and inventory"
          >
            Evidence & inventory
            <span className="ms-1.5 tabular-nums text-[var(--color-text-secondary)]">
              · {evidence.length}
            </span>
            {evidenceParsing ? (
              <span className="ms-1.5 text-[11px] font-medium text-[var(--color-state-warning)]">
                · Parsing
              </span>
            ) : null}
            {newEvidenceSinceReadCount > 0 ? (
              <span className="ms-1.5 text-[11px] font-medium text-[var(--color-accent-primary)]">
                · {newEvidenceSinceReadCount} new since diagnosis
              </span>
            ) : null}
          </Button>
        </div>
      </div>

      {isInspectOpen ? (
        <div
          className="pointer-events-none fixed inset-0 z-30 flex justify-end"
          aria-hidden={isDraftSheetOpen}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label="Dismiss proof panel"
            className="pointer-events-auto absolute inset-0 z-0 cursor-default border-0 bg-[rgba(0,0,0,0.032)] p-0 transition-colors duration-[var(--motion-slow)] motion-reduce:transition-none"
            onClick={closeInspectPanel}
          />
          <aside
            role="complementary"
            aria-label="Proof"
            className="targ-proof-panel-enter pointer-events-auto relative z-10 flex h-full w-full max-w-[min(100vw,360px)] flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] shadow-[-3px_0_20px_rgba(0,0,0,0.055)]"
          >
            <div className="flex shrink-0 items-center justify-between gap-3 px-6 py-3.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                Proof
              </span>
              <Button
                variant="tertiary"
                type="button"
                onClick={closeInspectPanel}
                className="min-h-9 rounded-[var(--radius-sm)] px-3 text-[12px] font-semibold"
              >
                Close
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-0">
              <InspectPanel
                evidence={evidence}
                diagnosis={currentDiagnosis}
                selectedClaimKey={selectedClaimKey}
                activeTab={inspectTab}
                onActiveTabChange={setInspectTab}
              />
            </div>
          </aside>
        </div>
      ) : null}

      {isEvidenceOpen ? (
        <div
          className="pointer-events-none fixed inset-0 z-[28] flex justify-end"
          aria-hidden={isDraftSheetOpen}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label="Dismiss evidence panel"
            className="pointer-events-auto absolute inset-0 z-0 cursor-default border-0 bg-[rgba(0,0,0,0.032)] p-0 transition-colors duration-[var(--motion-slow)] motion-reduce:transition-none"
            onClick={closeEvidencePanel}
          />
          <aside
            role="complementary"
            aria-label="Evidence and inventory"
            className="targ-proof-panel-enter pointer-events-auto relative z-10 flex h-full w-full max-w-[min(100vw,420px)] flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] shadow-[-3px_0_20px_rgba(0,0,0,0.055)]"
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] px-5 py-3 sm:px-6">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                Evidence
              </span>
              <Button
                variant="tertiary"
                type="button"
                onClick={closeEvidencePanel}
                className="min-h-9 rounded-[var(--radius-sm)] px-3 text-[12px] font-semibold"
              >
                Close
              </Button>
            </div>
            <div
              id="case-evidence-workspace"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-4 sm:px-6"
            >
              <CaseEvidenceWorkspace
                caseId={caseId}
                evidence={evidence}
                latestDiagnosis={currentDiagnosis}
                onEvidenceChange={setEvidence}
                variant="panel"
              />
            </div>
          </aside>
        </div>
      ) : null}

      <DraftReviewSheet
        draft={draft}
        evidence={evidence}
        currentDiagnosisId={currentDiagnosis?.id ?? null}
        isOpen={isDraftSheetOpen}
        isSaving={isSavingDraft}
        onClose={() => setIsDraftSheetOpen(false)}
        onSave={handleSaveDraft}
      />
    </div>
  );
}
