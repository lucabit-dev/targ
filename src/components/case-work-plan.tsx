"use client";

import { useMemo } from "react";

import { Button, Chip } from "@/components/ui/primitives";
import type {
  ActionDraftViewModel,
  BreakdownViewModel,
  DiagnosisSnapshotViewModel,
  WorkBundleViewModel,
} from "@/lib/analysis/view-model";
import {
  buildWorkPlanModel,
  workPlanTaskTypeLabel,
  type WorkPlanGroup,
  type WorkPlanTask,
} from "@/lib/analysis/work-plan";
import type {
  WorkBundleTask,
  WorkBundleTaskGroup,
  WorkTaskType,
} from "@/lib/planning/bundle-types";
import {
  PLAN_DEPTH_SEGMENT_LABELS,
  effectivePlanDepth,
  type CaseSolveModeValue,
} from "@/lib/planning/intake-preferences";
import { cn } from "@/lib/utils/cn";

const PLAN_DEPTH_ORDER: CaseSolveModeValue[] = [
  "quick_patch",
  "proper_fix",
  "strategic_improvement",
];

const PLAN_DEPTH_FULL: Record<CaseSolveModeValue, string> = {
  quick_patch: "Quick patch — minimal change, ship fast",
  proper_fix: "Proper fix — durable correction",
  strategic_improvement: "Strategic improvement — broader uplift",
};

const READINESS_COPY: Record<"fix" | "investigation", { headline: string }> = {
  fix: {
    headline: "Fix-ready plan",
  },
  investigation: {
    headline: "Investigation-ready plan",
  },
};

const WORK_BUNDLE_URGENCY_COPY = {
  low: "Low urgency",
  medium: "Medium urgency",
  high: "High urgency",
} as const;

const WORK_TASK_TYPE_LABELS: Record<WorkTaskType, string> = {
  research: "Research",
  design: "Design",
  implement: "Implement",
  verify: "Verify",
  communicate: "Communicate",
};

const PRIMARY_MODE_LABELS: Record<string, string> = {
  experience: "Experience",
  performance: "Performance",
  reliability: "Reliability",
  workflow_state: "Workflow",
  product_logic: "Product logic",
  concept_doctrine: "Doctrine",
  systems_structure: "System structure",
  functional_defect: "Functional defect",
};

const GROUP_DISCIPLINE_LABELS: Record<string, string> = {
  "group-trace": "Research",
  "group-unknowns": "Research",
  "group-product": "Product",
  "group-design": "Design",
  "group-next": "Engineering",
  "group-communication": "Communication",
};

type CaseWorkPlanProps = {
  diagnosis: DiagnosisSnapshotViewModel;
  draft: ActionDraftViewModel | null;
  draftReason: string | null;
  breakdown: BreakdownViewModel | null;
  workBundle: WorkBundleViewModel | null;
  isRegenerating: boolean;
  onReviewDraft: () => void;
  onRegenerateDraft: () => void;
  onOpenProof: (claimKey: string) => void;
  onOpenInspectUploads: () => void;
  planSolveMode: CaseSolveModeValue | null;
  onPlanDepthChange: (mode: CaseSolveModeValue) => void;
  planDepthSaving: boolean;
};

function WorkPlanTaskRow({
  task,
  onOpenProof,
}: {
  task: WorkPlanTask;
  onOpenProof: (claimKey: string) => void;
}) {
  const hasDetails = Boolean(task.doneCondition);

  return (
    <div className="py-2.5 sm:py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[13px] font-semibold leading-5 text-[var(--color-text-primary)]">
          {task.title}
        </p>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <Chip
            tone="subtle"
            className="rounded-[4px] px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.07em]"
          >
            {workPlanTaskTypeLabel(task.taskType)}
          </Chip>
          {task.proofClaimKey ? (
            <Button
              variant="tertiary"
              type="button"
              onClick={() => onOpenProof(task.proofClaimKey!)}
              className="min-h-8 rounded-[var(--radius-sm)] px-2 py-0 text-[10px] font-semibold"
            >
              Proof
            </Button>
          ) : null}
        </div>
      </div>
      {task.rationale.trim() ? (
        <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
          {task.rationale}
        </p>
      ) : null}
      {hasDetails ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]">
            Details
          </summary>
          <p className="mt-1.5 text-[11px] leading-[17px] text-[var(--color-text-muted)]">
            <span className="font-medium text-[var(--color-text-secondary)]">
              Done when:
            </span>{" "}
            {task.doneCondition}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function WorkPlanGroupBlock({
  group,
  onOpenProof,
}: {
  group: WorkPlanGroup;
  onOpenProof: (claimKey: string) => void;
}) {
  if (group.tasks.length === 0) {
    return null;
  }

  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
        {group.title}
      </h3>
      <div className="mt-2 divide-y divide-[var(--color-border-subtle)]/70 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/80 bg-[rgba(0,0,0,0.02)] px-3 sm:px-4">
        {group.tasks.map((task, index) => (
          <WorkPlanTaskRow
            key={`${group.id}-${index}-${task.title.slice(0, 24)}`}
            task={task}
            onOpenProof={onOpenProof}
          />
        ))}
      </div>
    </div>
  );
}

function BundleTaskRow({
  task,
  onOpenInspectUploads,
}: {
  task: WorkBundleTask;
  onOpenInspectUploads: () => void;
}) {
  const supportingLine = task.objective || task.rationale || null;
  const hasDetails =
    task.acceptanceCriteria.length > 0 ||
    task.evidenceLinkIds.length > 0 ||
    Boolean(task.unknownIds?.length) ||
    Boolean(task.hypothesisIds?.length);

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-5 text-[var(--color-text-primary)]">
            {task.title}
          </p>
          {supportingLine ? (
            <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
              {supportingLine}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <Chip
            tone="subtle"
            className="rounded-[4px] px-1.5 py-0 text-[9px] font-semibold uppercase tracking-[0.07em]"
          >
            {WORK_TASK_TYPE_LABELS[task.type]}
          </Chip>
          {task.evidenceLinkIds.length > 0 ? (
            <Button
              variant="tertiary"
              type="button"
              onClick={onOpenInspectUploads}
              className="min-h-8 rounded-[var(--radius-sm)] px-2 py-0 text-[10px] font-semibold"
            >
              Evidence
            </Button>
          ) : null}
        </div>
      </div>

      {hasDetails ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]">
            Details
          </summary>
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {task.evidenceLinkIds.length > 0 ? (
                <Chip className="text-[10px]">
                  {task.evidenceLinkIds.length} evidence link
                  {task.evidenceLinkIds.length === 1 ? "" : "s"}
                </Chip>
              ) : null}
              {task.unknownIds?.length ? (
                <Chip className="text-[10px]">
                  {task.unknownIds.length} gap
                  {task.unknownIds.length === 1 ? "" : "s"}
                </Chip>
              ) : null}
              {task.hypothesisIds?.length ? (
                <Chip className="text-[10px]">
                  {task.hypothesisIds.length} hypothesis
                  {task.hypothesisIds.length === 1 ? "" : "es"}
                </Chip>
              ) : null}
            </div>

            {task.acceptanceCriteria.length > 0 ? (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Done when
                </p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] leading-[17px] text-[var(--color-text-muted)]">
                  {task.acceptanceCriteria.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function BundleGroupBlock({
  group,
  onOpenInspectUploads,
  defaultOpen = false,
}: {
  group: WorkBundleTaskGroup;
  onOpenInspectUploads: () => void;
  defaultOpen?: boolean;
}) {
  const tasks = [...group.tasks].sort((a, b) => a.order - b.order);

  if (tasks.length === 0) {
    return null;
  }

  return (
    <details
      open={defaultOpen}
      className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/70 bg-[rgba(255,255,255,0.015)]"
    >
      <summary className="flex cursor-pointer list-none flex-col gap-1.5 px-3 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Chip className="text-[10px]">
              {GROUP_DISCIPLINE_LABELS[group.id] ?? `Track ${group.order}`}
            </Chip>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
              {group.title}
            </h3>
            {group.mode ? (
              <Chip className="text-[10px]">
                {PRIMARY_MODE_LABELS[group.mode] ?? group.mode}
              </Chip>
            ) : null}
          </div>
          {group.objective ? (
            <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
              {group.objective}
            </p>
          ) : null}
        </div>
        <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="border-t border-[var(--color-border-subtle)]/70 px-3 py-2.5 sm:px-4">
        {group.rationale ? (
          <p className="pb-2 text-[11px] leading-[17px] text-[var(--color-text-muted)]">
            {group.rationale}
          </p>
        ) : null}
        <div className="divide-y divide-[var(--color-border-subtle)]/70">
          {tasks.map((task) => (
            <BundleTaskRow
              key={task.id}
              task={task}
              onOpenInspectUploads={onOpenInspectUploads}
            />
          ))}
        </div>
      </div>
    </details>
  );
}

function bundleFirstTask(workBundle: WorkBundleViewModel | null) {
  const groups = [...(workBundle?.payload.taskGroups ?? [])].sort(
    (a, b) => a.order - b.order
  );

  for (const group of groups) {
    const tasks = [...group.tasks].sort((a, b) => a.order - b.order);
    if (tasks[0]) {
      return {
        group,
        task: tasks[0],
      };
    }
  }

  return null;
}

function bundleTaskCount(workBundle: WorkBundleViewModel | null) {
  return (workBundle?.payload.taskGroups ?? []).reduce(
    (count, group) => count + group.tasks.length,
    0
  );
}

function blockingUnknownCount(workBundle: WorkBundleViewModel | null) {
  return (
    workBundle?.payload.lineage.unknownsCarriedForward.filter((item) => item.blocking)
      .length ?? 0
  );
}

export function CaseWorkPlan({
  diagnosis,
  draft,
  draftReason,
  breakdown,
  workBundle,
  isRegenerating,
  onReviewDraft,
  onRegenerateDraft,
  onOpenProof,
  onOpenInspectUploads,
  planSolveMode,
  onPlanDepthChange,
  planDepthSaving,
}: CaseWorkPlanProps) {
  const planDepthEffective = effectivePlanDepth(planSolveMode);
  const activeWorkBundle =
    workBundle?.diagnosisSnapshotId === diagnosis.id ? workBundle : null;
  const activeBreakdown =
    breakdown?.diagnosisSnapshotId === diagnosis.id ? breakdown : null;

  const fallbackModel = useMemo(
    () => buildWorkPlanModel(diagnosis, draft, planDepthEffective),
    [diagnosis, draft, planDepthEffective]
  );

  const bundleGroups = useMemo(
    () =>
      activeWorkBundle
        ? [...activeWorkBundle.payload.taskGroups].sort((a, b) => a.order - b.order)
        : [],
    [activeWorkBundle]
  );

  const firstBundleTask = useMemo(
    () => bundleFirstTask(activeWorkBundle),
    [activeWorkBundle]
  );
  const bundleTaskTotal = useMemo(
    () => bundleTaskCount(activeWorkBundle),
    [activeWorkBundle]
  );
  const blockingUnknowns = useMemo(
    () => blockingUnknownCount(activeWorkBundle),
    [activeWorkBundle]
  );

  const fallbackReadiness = READINESS_COPY[fallbackModel.readiness];
  const immediateGroup =
    fallbackModel.groups.find((group) => group.id === "immediate") ?? null;
  const remainingGroups = fallbackModel.groups.filter((group) => group.id !== "immediate");

  return (
    <section
      id="case-work-plan"
      className="scroll-mt-8 max-lg:scroll-mt-[7.5rem]"
      aria-labelledby="case-work-plan-heading"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <h2
            id="case-work-plan-heading"
            className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]"
          >
            {activeWorkBundle ? "Tasks to solve this case" : "Work plan"}
          </h2>
          <p className="mt-2 text-[18px] font-semibold leading-[25px] tracking-[-0.03em] text-[var(--color-text-primary)] sm:text-[20px] sm:leading-[27px]">
            {activeWorkBundle
              ? `${bundleTaskTotal} task${bundleTaskTotal === 1 ? "" : "s"} across ${bundleGroups.length} track${bundleGroups.length === 1 ? "" : "s"}`
              : fallbackReadiness.headline}
          </p>
          <p className="mt-1 max-w-2xl text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
            {activeWorkBundle
              ? activeWorkBundle.payload.title
              : fallbackModel.strapline}
          </p>
          <p className="mt-1.5 max-w-2xl text-[12px] leading-[18px] text-[var(--color-text-muted)]">
            {activeWorkBundle
              ? `${activeWorkBundle.payload.rationale.whyNow} The tasks below are the AI-recommended path to solve the current case.`
              : fallbackModel.planDepthFraming}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {activeWorkBundle ? (
              <>
                <Chip className="text-[10px]">
                  {WORK_BUNDLE_URGENCY_COPY[activeWorkBundle.payload.urgency]}
                </Chip>
                {blockingUnknowns > 0 ? (
                  <Chip tone="warning" className="text-[10px]">
                    {blockingUnknowns} blocker{blockingUnknowns === 1 ? "" : "s"}
                  </Chip>
                ) : null}
                {activeBreakdown?.problemClassification?.primaryMode ? (
                  <Chip className="text-[10px]">
                    {PRIMARY_MODE_LABELS[activeBreakdown.problemClassification.primaryMode] ??
                      activeBreakdown.problemClassification.primaryMode}
                  </Chip>
                ) : null}
              </>
            ) : null}
            {draft?.status === "saved" ? (
              <Chip tone="success" className="text-[11px] font-semibold">
                Saved on case
              </Chip>
            ) : null}
          </div>
        </div>

        <div
          className="flex w-full shrink-0 flex-col gap-1 sm:w-auto sm:items-end"
          role="group"
          aria-label="Resolution style"
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
            Resolution style
          </span>
          <div className="inline-flex w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] p-0.5 sm:w-auto">
            {PLAN_DEPTH_ORDER.map((mode) => {
              const active = planDepthEffective === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  title={PLAN_DEPTH_FULL[mode]}
                  disabled={planDepthSaving}
                  aria-pressed={active}
                  onClick={() => onPlanDepthChange(mode)}
                  className={cn(
                    "min-h-8 flex-1 rounded-[6px] px-2 py-1 text-[11px] font-semibold leading-4 transition-colors duration-[var(--motion-fast)] sm:flex-none sm:px-2.5",
                    active
                      ? "bg-[var(--color-accent-primary)] text-[#0e1214]"
                      : "text-[var(--color-text-muted)] hover:bg-[rgba(255,255,255,0.05)] hover:text-[var(--color-text-secondary)]",
                    planDepthSaving && "opacity-60"
                  )}
                >
                  {PLAN_DEPTH_SEGMENT_LABELS[mode]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {activeWorkBundle ? (
        <>
          <div className="mt-4 rounded-[var(--radius-sm)] border border-[rgba(95,168,166,0.18)] bg-[rgba(95,168,166,0.05)] px-3 py-3 sm:px-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
              First task from the AI read
            </p>
            {firstBundleTask ? (
              <div className="mt-2 space-y-2">
                <p className="text-[14px] font-semibold leading-[20px] text-[var(--color-text-primary)]">
                  {firstBundleTask.task.title}
                </p>
                  <p className="text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                    {firstBundleTask.group.title}
                    {firstBundleTask.group.objective
                      ? ` · ${firstBundleTask.group.objective}`
                      : ""}
                  </p>
                <p className="text-[11px] leading-[17px] text-[var(--color-text-muted)]">
                  This is the smallest high-value move based on the current diagnosis and evidence set.
                </p>
                {firstBundleTask.task.acceptanceCriteria[0] ? (
                  <p className="text-[11px] leading-[17px] text-[var(--color-text-muted)]">
                    <span className="font-medium text-[var(--color-text-secondary)]">
                      Done when:
                    </span>{" "}
                    {firstBundleTask.task.acceptanceCriteria[0]}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                The work system is present, but no ordered first task was generated.
              </p>
            )}
          </div>

          <div className="mt-4 space-y-2.5">
            {bundleGroups.map((group, index) => (
              <BundleGroupBlock
                key={group.id}
                group={group}
                onOpenInspectUploads={onOpenInspectUploads}
                defaultOpen={index === 0}
              />
            ))}
          </div>

          {activeWorkBundle.payload.rationale.alternateApproach ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]">
                Alternate path
              </summary>
              <p className="mt-1.5 max-w-2xl text-[11px] leading-[17px] text-[var(--color-text-muted)]">
                {activeWorkBundle.payload.rationale.alternateApproach}
              </p>
            </details>
          ) : null}
        </>
      ) : (
        <>
          {fallbackModel.draftStale ? (
            <p className="mt-3 max-w-2xl border-l border-[var(--color-border-subtle)] pl-3 text-[12px] leading-[18px] text-[var(--color-text-muted)]">
              Draft predates this read—regenerate to align, then save again if you
              rely on it.
            </p>
          ) : null}

          {immediateGroup ? (
            <div className="mt-4 rounded-[var(--radius-sm)] border border-[rgba(95,168,166,0.22)] bg-[rgba(95,168,166,0.07)] px-3 py-3.5 sm:px-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">
                First move
              </p>
              <div className="mt-2 space-y-3">
                {immediateGroup.tasks.map((task, index) => (
                  <WorkPlanTaskRow
                    key={`${immediateGroup.id}-${index}-${task.title.slice(0, 24)}`}
                    task={task}
                    onOpenProof={onOpenProof}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-4 space-y-3">
            {remainingGroups.map((group) => (
              <WorkPlanGroupBlock
                key={group.id}
                group={group}
                onOpenProof={onOpenProof}
              />
            ))}
          </div>
        </>
      )}

      <div className="mt-6 flex flex-col gap-2 border-t border-[var(--color-border-subtle)]/80 pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <Button
          type="button"
          variant="primary"
          onClick={onReviewDraft}
          disabled={!draft}
          className="min-h-10 w-full text-[13px] font-semibold sm:w-auto sm:px-5"
        >
          {draft?.status === "saved"
            ? "Open handoff draft"
            : "Review handoff draft"}
        </Button>
        <Button
          variant="tertiary"
          type="button"
          onClick={onRegenerateDraft}
          disabled={isRegenerating || !diagnosis}
          className="w-full text-[12px] font-semibold sm:w-auto"
        >
          {isRegenerating
            ? "Regenerating…"
            : draft
              ? "Refresh handoff draft"
              : "Generate handoff draft"}
        </Button>
      </div>
      {!draft ? (
        <p className="mt-2 text-[12px] leading-[17px] text-[var(--color-text-muted)]">
          {draftReason ??
            "No handoff draft yet. Generate one when you want the AI diagnosis translated into a pinned handoff."}
        </p>
      ) : null}
    </section>
  );
}
