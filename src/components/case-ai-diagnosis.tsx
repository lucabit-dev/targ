import { Button, Chip } from "@/components/ui/primitives";
import { HandoffActions } from "@/components/handoff-actions";
import { DIAGNOSIS_CONFIDENCE_LABELS } from "@/lib/analysis/constants";
import type { ProblemBriefDisciplineInsight } from "@/lib/analysis/problem-brief";
import type {
  BreakdownViewModel,
  DiagnosisSnapshotViewModel,
  WorkBundleViewModel,
} from "@/lib/analysis/view-model";

type CaseAiDiagnosisProps = {
  caseId: string;
  diagnosis: DiagnosisSnapshotViewModel;
  breakdown: BreakdownViewModel | null;
  workBundle: WorkBundleViewModel | null;
  diagnosisIsStale: boolean;
  onOpenProof: (claimKey: string) => void;
  onOpenEvidence: () => void;
  onOpenIssues: () => void;
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

const DISCIPLINE_LABELS: Record<ProblemBriefDisciplineInsight["role"], string> = {
  research: "Research",
  product: "Product",
  design: "Design",
  engineering: "Engineering",
};

function countBundleTasks(workBundle: WorkBundleViewModel | null) {
  return (workBundle?.payload.taskGroups ?? []).reduce(
    (count, group) => count + group.tasks.length,
    0
  );
}

function countBundleTracks(workBundle: WorkBundleViewModel | null) {
  return workBundle?.payload.taskGroups.length ?? 0;
}

function primaryModeLabel(
  diagnosis: DiagnosisSnapshotViewModel,
  breakdown: BreakdownViewModel | null
) {
  const mode =
    diagnosis.problemBrief?.primaryMode ??
    breakdown?.problemClassification?.primaryMode ??
    null;

  if (!mode) {
    return "General";
  }

  return PRIMARY_MODE_LABELS[mode] ?? mode;
}

function firstTaskTitle(workBundle: WorkBundleViewModel | null) {
  for (const group of [...(workBundle?.payload.taskGroups ?? [])].sort(
    (a, b) => a.order - b.order
  )) {
    const task = [...group.tasks].sort((a, b) => a.order - b.order)[0];
    if (task) {
      return task.title;
    }
  }

  return null;
}

function whyThisCall(
  diagnosis: DiagnosisSnapshotViewModel,
  workBundle: WorkBundleViewModel | null
) {
  if (workBundle?.payload.rationale.headline?.trim()) {
    return workBundle.payload.rationale.headline.trim();
  }

  if (diagnosis.trace[0]?.claim?.trim()) {
    return diagnosis.trace[0].claim.trim();
  }

  return diagnosis.summary.trim();
}

function whatCouldChangeCall(diagnosis: DiagnosisSnapshotViewModel) {
  if (diagnosis.contradictions[0]?.trim()) {
    return diagnosis.contradictions[0].trim();
  }

  if (diagnosis.missingEvidence[0]?.trim()) {
    return diagnosis.missingEvidence[0].trim();
  }

  return "No major contradiction is active in the current read. Keep acting inside the current evidence boundary.";
}

function recommendationLine(
  diagnosis: DiagnosisSnapshotViewModel,
  workBundle: WorkBundleViewModel | null
) {
  const firstTask = firstTaskTitle(workBundle);

  if (firstTask) {
    return `Start with ${firstTask.toLowerCase()}.`;
  }

  return diagnosis.nextActionText;
}

function fallbackDisciplineInsights(
  diagnosis: DiagnosisSnapshotViewModel,
  workBundle: WorkBundleViewModel | null
) {
  return [
    {
      role: "research",
      read:
        diagnosis.trace[0]?.claim ??
        "The evidence set is still shaping the current read.",
      focus:
        diagnosis.missingEvidence[0] ??
        "Close the strongest missing signal before broadening the case.",
    },
    {
      role: "product",
      read:
        diagnosis.problemBrief?.userImpact ??
        "The case affects user or workflow outcomes, not just a technical boundary.",
      focus:
        diagnosis.problemBrief?.successSignal ??
        "Keep the next move anchored to the intended outcome.",
    },
    {
      role: "design",
      read:
        diagnosis.problemBrief?.primaryMode === "Experience"
          ? "This diagnosis has a visible product experience implication."
          : "Even when the issue is technical, the user-facing state still needs an intentional read.",
      focus:
        diagnosis.problemBrief?.primaryMode === "Experience"
          ? "Check the visible broken state, intended state, and recovery path."
          : "Verify UI, copy, and recovery states around the eventual fix.",
    },
    {
      role: "engineering",
      read: diagnosis.probableRootCause,
      focus: recommendationLine(diagnosis, workBundle),
    },
  ] satisfies ProblemBriefDisciplineInsight[];
}

function DiagnosisCard({
  label,
  body,
}: {
  label: string;
  body: string;
}) {
  return (
    <div className="space-y-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/70 bg-[rgba(255,255,255,0.015)] px-3 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {label}
      </p>
      <p className="text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
        {body}
      </p>
    </div>
  );
}

function DisciplineCard({
  insight,
}: {
  insight: ProblemBriefDisciplineInsight;
}) {
  return (
    <div className="grid gap-1.5 border-t border-[var(--color-border-subtle)]/60 py-3 first:border-t-0 first:pt-0 last:pb-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
        {DISCIPLINE_LABELS[insight.role]}
      </p>
      <p className="text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
        {insight.read}
      </p>
      <p className="text-[11px] leading-[17px] text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text-secondary)]">
          Best contribution now:
        </span>{" "}
        {insight.focus}
      </p>
    </div>
  );
}

export function CaseAiDiagnosis({
  caseId,
  diagnosis,
  breakdown,
  workBundle,
  diagnosisIsStale,
  onOpenProof,
  onOpenEvidence,
  onOpenIssues,
}: CaseAiDiagnosisProps) {
  const taskCount = countBundleTasks(workBundle);
  const trackCount = countBundleTracks(workBundle);
  const modeLabel = primaryModeLabel(diagnosis, breakdown);
  const firstClaimKey = diagnosis.trace[0]?.claimKey ?? null;
  const disciplineInsights =
    diagnosis.problemBrief?.disciplineInsights?.slice(0, 4) ??
    fallbackDisciplineInsights(diagnosis, workBundle);

  return (
    <section
      className="scroll-mt-8 max-lg:scroll-mt-[7.5rem]"
      aria-labelledby="case-ai-diagnosis-heading"
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-accent-primary)]">
                AI diagnosis
              </p>
              <h2
                id="case-ai-diagnosis-heading"
                className="mt-2 text-[20px] font-semibold leading-[27px] tracking-[-0.04em] text-[var(--color-text-primary)] sm:text-[22px] sm:leading-[29px]"
              >
                {diagnosis.summary}
              </h2>
              <p className="mt-2 max-w-2xl text-[13px] leading-[20px] text-[var(--color-text-secondary)]">
                Based on the current evidence, Targ&apos;s best call is{" "}
                <span className="text-[var(--color-text-primary)]">
                  {diagnosis.probableRootCause}
                </span>
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5 sm:justify-end">
              <Chip tone={diagnosis.confidence === "unclear" ? "warning" : "confidence"}>
                {DIAGNOSIS_CONFIDENCE_LABELS[diagnosis.confidence]}
              </Chip>
              <Chip>{modeLabel}</Chip>
              {taskCount > 0 ? (
                <Chip>
                  {taskCount} task{taskCount === 1 ? "" : "s"}
                </Chip>
              ) : null}
              {diagnosisIsStale ? <Chip tone="warning">Needs refresh</Chip> : null}
            </div>
          </div>

          <div className="grid gap-2.5 md:grid-cols-3">
            <DiagnosisCard
              label="Current call"
              body={whyThisCall(diagnosis, workBundle)}
            />
            <DiagnosisCard
              label="Next move"
              body={recommendationLine(diagnosis, workBundle)}
            />
            <DiagnosisCard
              label="Watch for"
              body={whatCouldChangeCall(diagnosis)}
            />
          </div>
        </div>

        <details className="group rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)]/70 bg-[rgba(255,255,255,0.015)] px-3 py-3">
          <summary className="flex cursor-pointer list-none flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                How Targ reads this case
              </p>
              <p className="mt-1 text-[12px] leading-[18px] text-[var(--color-text-secondary)]">
                See how Targ is interpreting the case as research, product, design, and engineering work.
              </p>
            </div>
            <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
              {trackCount > 0 ? `${trackCount} track${trackCount === 1 ? "" : "s"}` : "Open"}
            </span>
          </summary>
          <div className="mt-3">
            {disciplineInsights.map((insight) => (
              <DisciplineCard key={insight.role} insight={insight} />
            ))}
          </div>
        </details>

        <div className="flex flex-col gap-2 border-t border-[var(--color-border-subtle)]/70 pt-4 sm:flex-row sm:flex-wrap sm:items-center">
          {firstClaimKey ? (
            <Button
              variant="secondary"
              type="button"
              onClick={() => onOpenProof(firstClaimKey)}
              className="min-h-9 text-[12px] font-semibold"
            >
              Inspect proof
            </Button>
          ) : null}
          <Button
            variant="tertiary"
            type="button"
            onClick={onOpenEvidence}
            className="min-h-9 text-[12px] font-semibold"
          >
            Review evidence
          </Button>
          {(diagnosis.contradictions.length > 0 || diagnosis.missingEvidence.length > 0) ? (
            <Button
              variant="tertiary"
              type="button"
              onClick={onOpenIssues}
              className="min-h-9 text-[12px] font-semibold"
            >
              See gaps and conflicts
            </Button>
          ) : null}
        </div>

        <div className="border-t border-[var(--color-border-subtle)]/70 pt-4">
          <HandoffActions
            caseId={caseId}
            diagnosisId={diagnosis.id}
            disabled={diagnosisIsStale}
            disabledReason={
              diagnosisIsStale
                ? "This diagnosis is older than the current evidence. Re-run analysis before handing off."
                : undefined
            }
          />
        </div>
      </div>
    </section>
  );
}
